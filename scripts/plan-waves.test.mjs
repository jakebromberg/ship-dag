// Tests for the DAG planner. Run: node --test skills/ship-dag/scripts/
//
// The graph math itself lives in (and is tested by) the shared topo core in
// claude-orchestrator; these tests cover the ship-dag layer: spec→ref conversion
// and delegation, cross-repo body-edge parsing, and the gh-fetch wrapper.
// Everything the planner emits is keyed on composite refs ("owner/repo#N", or a
// bare "N" in single-repo back-compat).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { planWaves, readySet, bodyEdges, fetchSpec, parseFetchArgs } from './plan-waves.mjs';
import { WAVE_LABEL } from './lib/sub-issues.mjs';
import { graphqlAnswer, issueViewNotFound, notFoundBody, restFailure } from './lib/gh-fixture.mjs';

// A minimal `issue view` fixture, for the hierarchy tests where only the body
// (and hence the edges parsed out of it) varies between issues.
const issue = (number, body = '') => ({ number, title: `#${number}`, labels: [], body, state: 'OPEN' });

/** Parse `gh api graphql`'s `-F k=v` / `-f k=v` variable args into an object. */
function graphqlVars(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '-F' && argv[i] !== '-f') continue;
    const pair = argv[i + 1] || '';
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

/**
 * Build the `subIssues` response for whichever epic a GraphQL query names, from
 * the flat `fixtures.tree` description of a hierarchy. This lets a nested tree
 * be written once as `{ "o/r#1": [{number: 20}], "o/r#20": [{number: 21}] }`
 * instead of a hand-rolled envelope per level, and derives each child's
 * `subIssuesSummary.total` from whether the tree gives that child its own
 * entry — so the fixture can't disagree with itself about what is a container.
 *
 * An entry of `null` means "the parent declares children, but the query for
 * them comes back empty" (deleted epic, or one the token can't read): GitHub's
 * NOT_FOUND body, which `fakeGh` turns into gh's exit 1 as real gh does. An
 * entry of `{errors}` is any other GraphQL error body (a rate limit, say), also
 * an exit 1.
 */
function subIssuesResponse(tree, argv) {
  const vars = graphqlVars(argv);
  const repo = `${vars.owner}/${vars.name}`;
  const entry = tree[`${repo}#${vars.n}`];
  if (entry === undefined || entry === null) {
    return notFoundBody(vars.n);
  }
  if (entry.errors) return { errors: entry.errors };
  const pages = Array.isArray(entry) ? [entry] : entry.pages;
  const idx = vars.cursor ? Number(vars.cursor) : 0;
  const isLast = idx >= pages.length - 1;
  const childCount = (ref) => {
    const kids = tree[ref];
    if (kids === undefined) return 0;
    if (kids === null || kids.errors) return 1; // declared a container; its own query returns nothing
    return Array.isArray(kids) ? kids.length : kids.pages.flat().length;
  };
  const nodes = (pages[idx] || []).map((c) => {
    const childRepo = c.repo || repo;
    return {
      number: c.number,
      state: c.state || 'OPEN',
      repository: { nameWithOwner: childRepo },
      subIssuesSummary: { total: childCount(`${childRepo}#${c.number}`) },
      labels: { nodes: (c.labels || []).map((name) => ({ name })) },
    };
  });
  return {
    data: { repository: { issue: { subIssues: {
      nodes,
      pageInfo: { hasNextPage: !isLast, endCursor: isLast ? null : String(idx + 1) },
    } } } },
  };
}

// A fake `gh` runner: branches on argv so fetchSpec is testable without network.
// Records every invocation on `.calls` so tests can assert repo routing.
// `fixtures.blockedBy` (optional) maps a "repo#number" key to the array of ref
// strings the native `dependencies/blocked_by` endpoint would return for that
// node; a node with no entry (or when `fixtures.blockedBy` is omitted entirely)
// gets `[]`, matching a repo with no native dependencies configured.
// `fixtures.closedList` (optional) is what `issue list --state closed` returns;
// `fixtures.list` answers every other listing.
// `fixtures.tree` (optional) describes a whole sub-issue hierarchy keyed by epic
// ref — see `subIssuesResponse`. Without it, GraphQL calls fall back to the
// fixed `fixtures.graphql` envelope.
function fakeGh(fixtures) {
  const calls = [];
  const run = (argv) => {
    calls.push(argv);
    if (argv[0] === 'issue' && argv[1] === 'list') {
      const state = argv[argv.indexOf('--state') + 1];
      return JSON.stringify((state === 'closed' ? fixtures.closedList : fixtures.list) || []);
    }
    if (argv[0] === 'issue' && argv[1] === 'view') {
      const n = Number(argv[2]);
      if (!fixtures.issues[n]) throw issueViewNotFound(n, argv);
      return JSON.stringify(fixtures.issues[n]);
    }
    if (argv[0] === 'api' && argv[1] === 'graphql') {
      const body = fixtures.tree ? subIssuesResponse(fixtures.tree, argv) : fixtures.graphql;
      return graphqlAnswer(body, argv);
    }
    if (argv[0] === 'api' && argv.some((a) => /\/dependencies\/blocked_by$/.test(a))) {
      // `gh api --paginate --jq '… | "\(.repository.full_name)#\(.number)"'`
      // emits raw refs, one per line, concatenated across pages — not a JSON
      // array. The path arg moves when flags like --paginate precede it, so we
      // find it by shape rather than fixed index.
      const pathArg = argv.find((a) => /\/dependencies\/blocked_by$/.test(a));
      const m = pathArg.match(/^repos\/(.+)\/issues\/(\d+)\/dependencies\/blocked_by$/);
      const key = m ? `${m[1]}#${m[2]}` : '';
      return ((fixtures.blockedBy && fixtures.blockedBy[key]) || []).join('\n');
    }
    throw new Error('unexpected gh call: ' + argv.join(' '));
  };
  run.calls = calls;
  return run;
}

// ---- delegation: bare-number specs round-trip through the core as string refs -

test('no edges: every node is ready in one wave', () => {
  const { waves, blocked, cyclic } = planWaves({ nodes: [1, 2, 3], edges: [] });
  assert.deepEqual(waves, [['1', '2', '3']]);
  assert.deepEqual(blocked, []);
  assert.deepEqual(cyclic, []);
});

test('linear chain layers one per wave', () => {
  // 3 depends on 2 depends on 1
  const edges = [{ blocked: 3, blockedBy: 2 }, { blocked: 2, blockedBy: 1 }];
  const { waves } = planWaves({ nodes: [1, 2, 3], edges });
  assert.deepEqual(waves, [['1'], ['2'], ['3']]);
});

test('two independent + one dependent (the synthetic self-test DAG)', () => {
  // 3 depends on both 1 and 2; 1 and 2 are independent.
  const edges = [{ blocked: 3, blockedBy: 1 }, { blocked: 3, blockedBy: 2 }];
  const { waves, cyclic } = planWaves({ nodes: [1, 2, 3], edges });
  assert.deepEqual(waves, [['1', '2'], ['3']]);
  assert.deepEqual(cyclic, []);
});

test('done frontier advances the ready-set', () => {
  const edges = [{ blocked: 3, blockedBy: 1 }, { blocked: 3, blockedBy: 2 }];
  const { ready } = readySet({ nodes: [2, 3], edges, done: [1] });
  // 2 has no unmet deps → ready; 3 still blocked by 2.
  assert.deepEqual(ready, ['2']);
});

test('planWaves with a partially-merged DAG skips done nodes', () => {
  const edges = [{ blocked: 3, blockedBy: 1 }, { blocked: 3, blockedBy: 2 }];
  const { waves } = planWaves({ nodes: [1, 2, 3], edges, done: [1] });
  assert.deepEqual(waves, [['2'], ['3']]);
});

test('cycle is reported in cyclic, not silently dropped', () => {
  const edges = [{ blocked: 1, blockedBy: 2 }, { blocked: 2, blockedBy: 1 }];
  const { waves, cyclic } = planWaves({ nodes: [1, 2], edges });
  assert.deepEqual(waves, []);
  assert.deepEqual(cyclic, ['1', '2']);
});

test('a node blocked transitively by a cycle is caught in the cyclic remainder', () => {
  // 1<->2 cycle; 3 depends on 1.
  const edges = [
    { blocked: 1, blockedBy: 2 }, { blocked: 2, blockedBy: 1 }, { blocked: 3, blockedBy: 1 },
  ];
  const { waves, cyclic } = planWaves({ nodes: [1, 2, 3], edges });
  assert.deepEqual(waves, []);
  assert.deepEqual(cyclic, ['1', '2', '3']);
});

test('external blocker (dep out of scope, not done) is reported as blocked', () => {
  const edges = [{ blocked: 1, blockedBy: 99 }];
  const { waves, blocked, cyclic } = planWaves({ nodes: [1], edges });
  assert.deepEqual(waves, []);
  assert.deepEqual(blocked, [{ ref: '1', missing: ['99'], reason: 'external' }]);
  assert.deepEqual(cyclic, []);
});

test('external blocker satisfied by done unblocks the node', () => {
  const edges = [{ blocked: 1, blockedBy: 99 }];
  const { waves, blocked } = planWaves({ nodes: [1], edges, done: [99] });
  assert.deepEqual(waves, [['1']]);
  assert.deepEqual(blocked, []);
});

test('mixed: one wave, one external block, one cycle', () => {
  const edges = [
    { blocked: 3, blockedBy: 1 }, { blocked: 3, blockedBy: 2 }, // 3 after 1,2
    { blocked: 5, blockedBy: 99 },                               // 5 externally blocked
    { blocked: 7, blockedBy: 8 }, { blocked: 8, blockedBy: 7 },  // 7<->8 cycle
  ];
  const { waves, blocked, cyclic } = planWaves({ nodes: [1, 2, 3, 5, 7, 8], edges });
  assert.deepEqual(waves, [['1', '2'], ['3']]);
  assert.deepEqual(blocked, [{ ref: '5', missing: ['99'], reason: 'external' }]);
  assert.deepEqual(cyclic, ['7', '8']);
});

test('transitive block is labeled unreachable, not external', () => {
  // 2 depends on external 99; 3 depends on 2 (in-scope but dropped).
  const edges = [{ blocked: 2, blockedBy: 99 }, { blocked: 3, blockedBy: 2 }];
  const { waves, blocked } = planWaves({ nodes: [2, 3], edges });
  assert.deepEqual(waves, []);
  assert.deepEqual(blocked, [
    { ref: '2', missing: ['99'], reason: 'external' },
    { ref: '3', missing: ['2'], reason: 'unreachable' },
  ]);
});

// ---- composite refs: cross-repo keying and edges -------------------------

test('a bare cross-repo dependency is qualified and blocks externally', () => {
  // o/r#3 depends on in-scope o/r#1 and out-of-scope other/repo#2.
  const spec = {
    repo: 'o/r',
    nodes: [{ number: 1 }, { number: 3 }],
    edges: [{ blocked: 3, blockedBy: 1 }, { blocked: 3, blockedBy: 'other/repo#2' }],
  };
  const { waves, blocked } = planWaves(spec);
  assert.deepEqual(waves, [['o/r#1']]);
  assert.deepEqual(blocked, [{ ref: 'o/r#3', missing: ['other/repo#2'], reason: 'external' }]);
});

test('the same issue number in two repos stays two distinct nodes', () => {
  // a/x#5 must precede b/y#5 — a shared bare-number key would collapse them.
  const spec = {
    nodes: [{ ref: 'a/x#5' }, { ref: 'b/y#5' }],
    edges: [{ blocked: 'b/y#5', blockedBy: 'a/x#5' }],
  };
  const { waves, cyclic } = planWaves(spec);
  assert.deepEqual(waves, [['a/x#5'], ['b/y#5']]);
  assert.deepEqual(cyclic, []);
});

// ---- bodyEdges: multi-issue clauses, reverse direction, cross-repo -------

test('bodyEdges qualifies bare refs to the citing repo, both directions', () => {
  const cite = { number: 5, repo: 'o/r' };
  assert.deepEqual(bodyEdges(cite, 'Blocked by #12, #13 and #14.'), [
    { blocked: 'o/r#5', blockedBy: 'o/r#12' },
    { blocked: 'o/r#5', blockedBy: 'o/r#13' },
    { blocked: 'o/r#5', blockedBy: 'o/r#14' },
  ]);
  assert.deepEqual(bodyEdges(cite, 'Depends on #1'), [{ blocked: 'o/r#5', blockedBy: 'o/r#1' }]);
  assert.deepEqual(bodyEdges(cite, 'This blocks #20 and #21'), [
    { blocked: 'o/r#20', blockedBy: 'o/r#5' },
    { blocked: 'o/r#21', blockedBy: 'o/r#5' },
  ]);
  assert.deepEqual(bodyEdges(cite, 'no dependencies here'), []);
});

test('bodyEdges keeps a fully-qualified cross-repo ref and qualifies the bare one', () => {
  assert.deepEqual(bodyEdges({ number: 5, repo: 'o/r' }, 'Blocked by other/repo#3 and #4'), [
    { blocked: 'o/r#5', blockedBy: 'other/repo#3' },
    { blocked: 'o/r#5', blockedBy: 'o/r#4' },
  ]);
});

test('bodyEdges with a bare-number citing (no repo) emits bare refs', () => {
  assert.deepEqual(bodyEdges(5, 'Blocked by #12'), [{ blocked: '5', blockedBy: '12' }]);
});

// ---- bodyEdges: "## Blocked by" heading + bulleted-list layout -----------

test('bodyEdges captures refs from a "## Blocked by" heading with a bulleted list', () => {
  const cite = { number: 270, repo: 'WXYC/Backend-Service' };
  const body = [
    'Some preamble text.',
    '',
    '## Blocked by',
    '- WXYC/Backend-Service#877 — Epic C …',
    '- WXYC/Backend-Service#878 — Epic D …',
    '',
    '## Description',
    'Everything else.',
  ].join('\n');
  assert.deepEqual(bodyEdges(cite, body), [
    { blocked: 'WXYC/Backend-Service#270', blockedBy: 'WXYC/Backend-Service#877' },
    { blocked: 'WXYC/Backend-Service#270', blockedBy: 'WXYC/Backend-Service#878' },
  ]);
});

test('bodyEdges captures a "Depends on" heading list and stops at the next heading', () => {
  const cite = { number: 5, repo: 'o/r' };
  const body = ['Depends on:', '- #1', '- #2', '## Next section', '- #99 — unrelated bullet'].join('\n');
  assert.deepEqual(bodyEdges(cite, body), [
    { blocked: 'o/r#5', blockedBy: 'o/r#1' },
    { blocked: 'o/r#5', blockedBy: 'o/r#2' },
  ]);
});

test('bodyEdges skips a heading-list bullet annotated as already resolved', () => {
  const cite = { number: 270, repo: 'o/r' };
  const body = ['## Blocked by', '- #877 — RESOLVED, merged in #900', '- #878 — Epic D still open'].join('\n');
  assert.deepEqual(bodyEdges(cite, body), [{ blocked: 'o/r#270', blockedBy: 'o/r#878' }]);
});

test('bodyEdges heading-list scan stops at a blank line', () => {
  const cite = { number: 5, repo: 'o/r' };
  const body = ['## Blocked by', '- #1', '', '- #2 (not part of the list, separated by blank line)'].join('\n');
  assert.deepEqual(bodyEdges(cite, body), [{ blocked: 'o/r#5', blockedBy: 'o/r#1' }]);
});

test('bodyEdges captures a heading list separated from the heading by a blank line', () => {
  // The markdownlint-standard layout (MD022/MD032) puts a blank line between a
  // heading and its list; a leading blank BEFORE the first bullet must not end
  // the scan. (A blank AFTER a bullet still ends it — see the test above.)
  const cite = { number: 5, repo: 'o/r' };
  const body = ['## Blocked by', '', '- #877', '- #878'].join('\n');
  assert.deepEqual(bodyEdges(cite, body), [
    { blocked: 'o/r#5', blockedBy: 'o/r#877' },
    { blocked: 'o/r#5', blockedBy: 'o/r#878' },
  ]);
});

test('bodyEdges captures a heading list under a heading with a trailing count/note', () => {
  // Real headings carry counts and parentheticals ("### Blocked by (2)"); the
  // heading matcher must tolerate trailing text that is not a ref.
  const cite = { number: 7, repo: 'o/r' };
  const body = ['### Blocked by (2)', '- #5', '- #6'].join('\n');
  assert.deepEqual(bodyEdges(cite, body), [
    { blocked: 'o/r#7', blockedBy: 'o/r#5' },
    { blocked: 'o/r#7', blockedBy: 'o/r#6' },
  ]);
});

test('bodyEdges keeps a live heading-list bullet whose prose merely contains the word "resolved"', () => {
  // The stale-bullet skip must key on a real status marker ("— RESOLVED"), not
  // any occurrence of the word; dropping a live blocker is the dangerous
  // direction (issue reported ready while blocked).
  const cite = { number: 7, repo: 'o/r' };
  const body = ['## Blocked by', '- #5 — blocks the resolved-tickets export view'].join('\n');
  assert.deepEqual(bodyEdges(cite, body), [{ blocked: 'o/r#7', blockedBy: 'o/r#5' }]);
});

test('bodyEdges dedupes when the adjacent-clause and heading-list forms overlap', () => {
  const cite = { number: 5, repo: 'o/r' };
  const body = ['Blocked by #1.', '', '## Blocked by', '- #1', '- #2'].join('\n');
  assert.deepEqual(bodyEdges(cite, body), [
    { blocked: 'o/r#5', blockedBy: 'o/r#1' },
    { blocked: 'o/r#5', blockedBy: 'o/r#2' },
  ]);
});

test('bodyEdges keeps existing adjacent-clause and reverse-direction matching working alongside heading lists', () => {
  const cite = { number: 5, repo: 'o/r' };
  const body = ['Blocked by #12, #13 and #14.', '', 'This blocks #20.'].join('\n');
  assert.deepEqual(bodyEdges(cite, body), [
    { blocked: 'o/r#5', blockedBy: 'o/r#12' },
    { blocked: 'o/r#5', blockedBy: 'o/r#13' },
    { blocked: 'o/r#5', blockedBy: 'o/r#14' },
    { blocked: 'o/r#20', blockedBy: 'o/r#5' },
  ]);
});

// ---- fetchSpec: composite refs, cross-repo, closed-dep resolution --------

test('fetchSpec records a closed dependency as done, not an external block', () => {
  const gh = fakeGh({
    list: [{ number: 5 }, { number: 6 }],
    issues: {
      5: { number: 5, title: 'a', labels: [], body: 'Blocked by #3 and #6', state: 'OPEN' },
      6: { number: 6, title: 'b', labels: [], body: '', state: 'OPEN' },
      3: { state: 'CLOSED' }, // already merged dependency, not in the open node set
    },
  });
  const spec = fetchSpec('o/r', { label: 'ship' }, gh);
  assert.deepEqual(spec.done, ['o/r#3']);
  assert.deepEqual(spec.nodes.map((n) => n.ref), ['o/r#5', 'o/r#6']);
  // #3 (closed) is satisfied, so #6 ships first, then #5 — no false external block.
  const { waves, blocked } = planWaves(spec);
  assert.deepEqual(waves, [['o/r#6'], ['o/r#5']]);
  assert.deepEqual(blocked, []);
});

test('fetchSpec resolves a cross-repo closed dependency in its own repo', () => {
  const gh = fakeGh({
    list: [{ number: 5 }],
    issues: {
      5: { number: 5, title: 'a', labels: [], body: 'Blocked by other/repo#3', state: 'OPEN' },
      3: { state: 'CLOSED' },
    },
  });
  const spec = fetchSpec('o/r', { label: 'ship' }, gh);
  assert.deepEqual(spec.done, ['other/repo#3']);
  // The dep was viewed in its OWN repo, not the epic/label repo.
  assert.ok(gh.calls.some((a) => a.join(' ') === 'issue view 3 --repo other/repo --json state'));
  const { waves, blocked } = planWaves(spec);
  assert.deepEqual(waves, [['o/r#5']]);
  assert.deepEqual(blocked, []);
});

test('fetchSpec epic path throws a clear error when the issue/sub-issues are absent', () => {
  const gh = fakeGh({ graphql: { data: { repository: { issue: null } } } });
  assert.throws(() => fetchSpec('o/r', { epic: 999 }, gh), /no sub-issues returned/);
});

test('fetchSpec names the root epic on any other failure listing it, with the original as cause', () => {
  // A 502 on the root still aborts and is never SubIssuesUnavailable; it just keeps saying which epic failed.
  const boom = restFailure(502, 'Bad Gateway', ['api', 'graphql']);
  assert.throws(() => fetchSpec('o/r', { epic: 1 }, () => { throw boom; }),
    (e) => e.constructor === Error && e.message === `epic #1 in o/r: ${boom.message}` && e.cause === boom);
});

test('fetchSpec epic path drops closed sub-issues and paginates', () => {
  const gh = fakeGh({
    graphql: {
      data: { repository: { issue: { subIssues: {
        nodes: [
          { number: 10, state: 'OPEN', repository: { nameWithOwner: 'o/r' } },
          { number: 11, state: 'CLOSED', repository: { nameWithOwner: 'o/r' } },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } },
    },
    issues: { 10: { number: 10, title: 'x', labels: [], body: '', state: 'OPEN' } },
  });
  const spec = fetchSpec('o/r', { epic: 1 }, gh);
  assert.deepEqual(spec.nodes.map((n) => n.ref), ['o/r#10']);
});

test('fetchSpec keeps a cross-repo sub-issue keyed on its own repo', () => {
  const gh = fakeGh({
    graphql: {
      data: { repository: { issue: { subIssues: {
        nodes: [{ number: 10, state: 'OPEN', repository: { nameWithOwner: 'other/repo' } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } },
    },
    issues: { 10: { number: 10, title: 'x', labels: [], body: '', state: 'OPEN' } },
  });
  const spec = fetchSpec('o/r', { epic: 1 }, gh);
  assert.deepEqual(spec.nodes[0].ref, 'other/repo#10');
  assert.deepEqual(spec.nodes[0].repo, 'other/repo');
  // The body was fetched from the sub-issue's own repo.
  assert.ok(gh.calls.some((a) => a.join(' ').startsWith('issue view 10 --repo other/repo')));
});

// ---- fetchSpec: native issue-dependency ("blocked_by") merge -------------

test('fetchSpec has no native-dependency calls fail a repo where none are configured', () => {
  // The fake runner answers the dependencies call with [] whenever a test
  // doesn't populate `fixtures.blockedBy` — same as a repo with no native
  // dependency graph configured. Existing prose-only behavior is unaffected.
  const gh = fakeGh({
    list: [{ number: 5 }],
    issues: { 5: { number: 5, title: 'a', labels: [], body: 'Blocked by #6', state: 'OPEN' } },
  });
  const spec = fetchSpec('o/r', { label: 'ship' }, gh);
  assert.deepEqual(spec.edges, [{ blocked: 'o/r#5', blockedBy: 'o/r#6' }]);
});

test('fetchSpec merges a native blocked_by pointing at an open out-of-set issue as an external blocker', () => {
  // #5 has no prose dependency, but natively lists #99 (never fetched — out of
  // scope and still open) as a blocker. Missing this is the dangerous failure
  // direction: #5 must land in `blocked (external)`, not in wave 1.
  const gh = fakeGh({
    list: [{ number: 5 }],
    issues: { 5: { number: 5, title: 'a', labels: [], body: 'no prose deps here', state: 'OPEN' } },
    blockedBy: { 'o/r#5': ['o/r#99'] },
  });
  const spec = fetchSpec('o/r', { label: 'ship' }, gh);
  assert.deepEqual(spec.edges, [{ blocked: 'o/r#5', blockedBy: 'o/r#99' }]);
  const { waves, blocked } = planWaves(spec);
  assert.deepEqual(waves, []);
  assert.deepEqual(blocked, [{ ref: 'o/r#5', missing: ['o/r#99'], reason: 'external' }]);
});

test('fetchSpec resolves a native blocked_by against a closed issue into done, not an external block', () => {
  const gh = fakeGh({
    list: [{ number: 5 }],
    issues: {
      5: { number: 5, title: 'a', labels: [], body: '', state: 'OPEN' },
      3: { state: 'CLOSED' },
    },
    blockedBy: { 'o/r#5': ['o/r#3'] },
  });
  const spec = fetchSpec('o/r', { label: 'ship' }, gh);
  assert.deepEqual(spec.done, ['o/r#3']);
  const { waves, blocked } = planWaves(spec);
  assert.deepEqual(waves, [['o/r#5']]);
  assert.deepEqual(blocked, []);
});

test('fetchSpec dedupes a native/prose duplicate edge', () => {
  // #5's body says "Blocked by #6" AND #6 is also its native blocker — the same
  // pair from two sources must collapse to one edge, not double up in the DAG.
  const gh = fakeGh({
    list: [{ number: 5 }, { number: 6 }],
    issues: {
      5: { number: 5, title: 'a', labels: [], body: 'Blocked by #6', state: 'OPEN' },
      6: { number: 6, title: 'b', labels: [], body: '', state: 'OPEN' },
    },
    blockedBy: { 'o/r#5': ['o/r#6'] },
  });
  const spec = fetchSpec('o/r', { label: 'ship' }, gh);
  assert.deepEqual(spec.edges, [{ blocked: 'o/r#5', blockedBy: 'o/r#6' }]);
});

test('fetchSpec fetches native blocked_by with --paginate so >30 blockers are not truncated', () => {
  // GitHub REST returns 30 items/page; without --paginate an issue with more
  // than 30 native blockers is silently truncated — the dangerous direction.
  const gh = fakeGh({
    list: [{ number: 5 }],
    issues: { 5: { number: 5, title: 'a', labels: [], body: '', state: 'OPEN' } },
    blockedBy: { 'o/r#5': [] },
  });
  fetchSpec('o/r', { label: 'ship' }, gh);
  const nativeCall = gh.calls.find(
    (a) => a[0] === 'api' && a.some((x) => /\/dependencies\/blocked_by$/.test(x)),
  );
  assert.ok(nativeCall, 'a native blocked_by call was made');
  assert.ok(nativeCall.includes('--paginate'), 'the native call passes --paginate');
});

test('fetchSpec tolerates a native blocked_by call failing (unconfigured/no access)', () => {
  const gh = fakeGh({
    list: [{ number: 5 }],
    issues: { 5: { number: 5, title: 'a', labels: [], body: '', state: 'OPEN' } },
  });
  const throwingGh = (argv) => {
    if (argv[0] === 'api' && argv.some((a) => /\/dependencies\/blocked_by$/.test(a))) {
      throw restFailure(404, 'Not Found', argv);
    }
    return gh(argv);
  };
  const spec = fetchSpec('o/r', { label: 'ship' }, throwingGh);
  assert.deepEqual(spec.edges, []);
});

// ---- fetchSpec: epic-as-blocker edge pruning ------------------------------

test('fetchSpec drops an epic-path child\'s native blocked_by edge to its own containing epic', () => {
  // #10 is a sub-issue of epic #1 and natively lists #1 (its own epic) as a
  // blocker — GitHub surfaces that relationship as a dependency even though
  // it's just "this is part of that epic". Left in, #10 would be stranded in
  // `blocked (external)` forever, since the epic stays open until #10 (its
  // last child) closes — a false "everything blocked" trading places with the
  // false "everything ready" this whole change is fixing.
  const gh = fakeGh({
    graphql: {
      data: { repository: { issue: { subIssues: {
        nodes: [{ number: 10, state: 'OPEN', repository: { nameWithOwner: 'o/r' } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } },
    },
    issues: { 10: { number: 10, title: 'x', labels: [], body: '', state: 'OPEN' } },
    blockedBy: { 'o/r#10': ['o/r#1'] },
  });
  const spec = fetchSpec('o/r', { epic: 1 }, gh);
  assert.deepEqual(spec.edges, []);
  const { waves, blocked } = planWaves(spec);
  assert.deepEqual(waves, [['o/r#10']]);
  assert.deepEqual(blocked, []);
});

test('fetchSpec keeps a genuine sibling blocker on an epic-path child (only the epic-self edge is pruned)', () => {
  // #11 is blocked by sibling #10 (a real, in-DAG dependency) AND lists the
  // epic #1 itself as a blocker. Only the epic-self edge should be dropped.
  const gh = fakeGh({
    graphql: {
      data: { repository: { issue: { subIssues: {
        nodes: [
          { number: 10, state: 'OPEN', repository: { nameWithOwner: 'o/r' } },
          { number: 11, state: 'OPEN', repository: { nameWithOwner: 'o/r' } },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } },
    },
    issues: {
      10: { number: 10, title: 'x', labels: [], body: '', state: 'OPEN' },
      11: { number: 11, title: 'y', labels: [], body: '', state: 'OPEN' },
    },
    blockedBy: { 'o/r#11': ['o/r#1', 'o/r#10'] },
  });
  const spec = fetchSpec('o/r', { epic: 1 }, gh);
  assert.deepEqual(spec.edges, [{ blocked: 'o/r#11', blockedBy: 'o/r#10' }]);
  const { waves } = planWaves(spec);
  assert.deepEqual(waves, [['o/r#10'], ['o/r#11']]);
});

// ---- fetchSpec: recursive sub-issue descent -------------------------------

test('fetchSpec descends into a nested epic, replacing it with its own children', () => {
  // Epic #1 holds leaf #10 and epic #20; #20 holds #21 and #22. An intermediate
  // epic is a grouping, not a unit of work — shipping it would hand a whole
  // sub-tree to one implement subagent — so it is replaced by its leaves.
  const gh = fakeGh({
    tree: {
      'o/r#1': [{ number: 10 }, { number: 20 }],
      'o/r#20': [{ number: 21 }, { number: 22 }],
    },
    issues: { 10: issue(10), 20: issue(20), 21: issue(21), 22: issue(22) },
  });
  const spec = fetchSpec('o/r', { epic: 1 }, gh);
  assert.deepEqual(spec.nodes.map((n) => n.ref), ['o/r#10', 'o/r#21', 'o/r#22']);
});

test('fetchSpec descends to arbitrary depth, not just one nested level', () => {
  const gh = fakeGh({
    tree: {
      'o/r#1': [{ number: 20 }],
      'o/r#20': [{ number: 30 }],
      'o/r#30': [{ number: 31 }, { number: 32 }],
    },
    issues: { 20: issue(20), 30: issue(30), 31: issue(31), 32: issue(32) },
  });
  const spec = fetchSpec('o/r', { epic: 1 }, gh);
  assert.deepEqual(spec.nodes.map((n) => n.ref), ['o/r#31', 'o/r#32']);
});

test('fetchSpec does not spend a sub-issue query on a leaf', () => {
  // `subIssuesSummary.total` rides along in the parent's response, so a leaf is
  // known to be a leaf without a round trip of its own. Only the root is queried.
  const gh = fakeGh({ tree: { 'o/r#1': [{ number: 10 }, { number: 11 }] }, issues: { 10: issue(10), 11: issue(11) } });
  fetchSpec('o/r', { epic: 1 }, gh);
  assert.equal(gh.calls.filter((a) => a[0] === 'api' && a[1] === 'graphql').length, 1);
});

test('fetchSpec walks a cross-repo nested epic in its own repo', () => {
  const gh = fakeGh({
    tree: {
      'o/r#1': [{ number: 20, repo: 'other/repo' }],
      'other/repo#20': [{ number: 21 }],
    },
    issues: { 20: issue(20), 21: issue(21) },
  });
  const spec = fetchSpec('o/r', { epic: 1 }, gh);
  assert.deepEqual(spec.nodes.map((n) => n.ref), ['other/repo#21']);
  const descent = gh.calls.filter((a) => a[0] === 'api' && a[1] === 'graphql').map(graphqlVars);
  assert.ok(descent.some((v) => v.owner === 'other' && v.name === 'repo' && v.n === '20'),
    'the nested epic was queried in its own repo');
});

test('fetchSpec terminates on a cyclic sub-issue hierarchy', () => {
  // A malformed hierarchy where a descendant claims the root as its own child.
  // The visited set must stop the walk rather than loop forever.
  const gh = fakeGh({
    tree: {
      'o/r#1': [{ number: 20 }],
      'o/r#20': [{ number: 1 }, { number: 21 }],
    },
    issues: { 20: issue(20), 21: issue(21) },
  });
  const spec = fetchSpec('o/r', { epic: 1 }, gh);
  assert.deepEqual(spec.nodes.map((n) => n.ref), ['o/r#21']);
});

test('fetchSpec does not descend into a closed nested epic', () => {
  // A closed sub-issue is already out of scope at depth 1; closing an epic
  // takes its whole sub-tree out with it, consistently.
  const gh = fakeGh({
    tree: {
      'o/r#1': [{ number: 20, state: 'CLOSED' }, { number: 10 }],
      'o/r#20': [{ number: 21 }],
    },
    issues: { 10: issue(10) },
  });
  const spec = fetchSpec('o/r', { epic: 1 }, gh);
  assert.deepEqual(spec.nodes.map((n) => n.ref), ['o/r#10']);
  const descent = gh.calls.filter((a) => a[0] === 'api' && a[1] === 'graphql').map(graphqlVars);
  assert.ok(!descent.some((v) => v.n === '20'), 'the closed epic was not expanded');
});

test('fetchSpec paginates a nested epic, not just the root', () => {
  const gh = fakeGh({
    tree: {
      'o/r#1': [{ number: 20 }],
      'o/r#20': { pages: [[{ number: 21 }], [{ number: 22 }]] },
    },
    issues: { 20: issue(20), 21: issue(21), 22: issue(22) },
  });
  const spec = fetchSpec('o/r', { epic: 1 }, gh);
  assert.deepEqual(spec.nodes.map((n) => n.ref), ['o/r#21', 'o/r#22']);
});

test('fetchSpec keeps a nested epic as a node when its children cannot be read', () => {
  // #20 is declared a container by its parent, but its own sub-issue query comes
  // back empty (deleted, or invisible to the token). Dropping it would silently
  // lose the work; keeping it as a node is the recoverable direction.
  const gh = fakeGh({
    tree: { 'o/r#1': [{ number: 10 }, { number: 20 }], 'o/r#20': null },
    issues: { 10: issue(10), 20: issue(20) },
  });
  const spec = fetchSpec('o/r', { epic: 1 }, gh);
  assert.deepEqual(spec.nodes.map((n) => n.ref).sort(), ['o/r#10', 'o/r#20']);
});

test('fetchSpec aborts, never demotes, when a nested epic or wave sub-epic hits any other gh failure', () => {
  // A rate limit says nothing about #20's children, so shipping it as one issue
  // would hand its whole sub-tree to one subagent. The fetch exits; re-run it.
  const limited = { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] };
  for (const labels of [undefined, [WAVE_LABEL]]) {
    const warns = [];
    const gh = fakeGh({
      tree: { 'o/r#1': [{ number: 10 }, { number: 20, labels }], 'o/r#20': limited },
      issues: { 10: issue(10), 20: issue(20) },
    });
    assert.throws(() => fetchSpec('o/r', { epic: 1, warn: (m) => warns.push(m) }, gh),
      (e) => /Command failed/.test(e.message) && /RATE_LIMITED/.test(e.stdout), labels ? 'wave' : 'nested epic');
    assert.deepEqual(warns, []);
  }
});

// ---- fetchSpec: container-edge rewriting ----------------------------------

test('fetchSpec expands an edge naming a container epic into edges to its leaves', () => {
  // "#10 is blocked by epic #20" means #10 waits for everything in #20. Left
  // pointing at #20 the edge could never be satisfied — an epic stays open until
  // its last child closes — so #10 would be stranded as externally blocked.
  const gh = fakeGh({
    tree: {
      'o/r#1': [{ number: 10 }, { number: 20 }],
      'o/r#20': [{ number: 21 }, { number: 22 }],
    },
    issues: { 10: issue(10, 'Blocked by #20'), 20: issue(20), 21: issue(21), 22: issue(22) },
  });
  const spec = fetchSpec('o/r', { epic: 1 }, gh);
  assert.deepEqual(spec.edges, [
    { blocked: 'o/r#10', blockedBy: 'o/r#21' },
    { blocked: 'o/r#10', blockedBy: 'o/r#22' },
  ]);
  const { waves, blocked } = planWaves(spec);
  assert.deepEqual(waves, [['o/r#21', 'o/r#22'], ['o/r#10']]);
  assert.deepEqual(blocked, []);
});

test('fetchSpec pushes a container epic\'s own blocker down onto each of its leaves', () => {
  // Epic #20 declares a blocker. #20 never ships as a node, so the constraint
  // has to land on the children that ship in its place.
  const gh = fakeGh({
    tree: {
      'o/r#1': [{ number: 10 }, { number: 20 }],
      'o/r#20': [{ number: 21 }, { number: 22 }],
    },
    issues: { 10: issue(10), 20: issue(20, 'Blocked by #10'), 21: issue(21), 22: issue(22) },
  });
  const spec = fetchSpec('o/r', { epic: 1 }, gh);
  assert.deepEqual(spec.edges, [
    { blocked: 'o/r#21', blockedBy: 'o/r#10' },
    { blocked: 'o/r#22', blockedBy: 'o/r#10' },
  ]);
  const { waves } = planWaves(spec);
  assert.deepEqual(waves, [['o/r#10'], ['o/r#21', 'o/r#22']]);
});

test('fetchSpec pushes a container epic\'s native blocker down, keeping it externally blocked', () => {
  // The same push-down, from the native dependency graph rather than prose, and
  // onto a blocker that is out of scope: both leaves must stay blocked.
  const gh = fakeGh({
    tree: { 'o/r#1': [{ number: 20 }], 'o/r#20': [{ number: 21 }, { number: 22 }] },
    issues: { 20: issue(20), 21: issue(21), 22: issue(22), 99: { state: 'OPEN' } },
    blockedBy: { 'o/r#20': ['o/r#99'] },
  });
  const spec = fetchSpec('o/r', { epic: 1 }, gh);
  assert.deepEqual(spec.edges, [
    { blocked: 'o/r#21', blockedBy: 'o/r#99' },
    { blocked: 'o/r#22', blockedBy: 'o/r#99' },
  ]);
  const { waves, blocked } = planWaves(spec);
  assert.deepEqual(waves, []);
  assert.deepEqual(blocked, [
    { ref: 'o/r#21', missing: ['o/r#99'], reason: 'external' },
    { ref: 'o/r#22', missing: ['o/r#99'], reason: 'external' },
  ]);
});

test('fetchSpec drops a nested child\'s blocked_by edge to any of its ancestor epics', () => {
  // The depth-1 epic-self rule, generalized: an edge to a *containing* epic at
  // any depth is "this is part of that", not a dependency. Both #20 (parent) and
  // #1 (grandparent) are containment artifacts for #21.
  const gh = fakeGh({
    tree: { 'o/r#1': [{ number: 20 }], 'o/r#20': [{ number: 21 }] },
    issues: { 20: issue(20), 21: issue(21) },
    blockedBy: { 'o/r#21': ['o/r#20', 'o/r#1'] },
  });
  const spec = fetchSpec('o/r', { epic: 1 }, gh);
  assert.deepEqual(spec.edges, []);
  const { waves, blocked } = planWaves(spec);
  assert.deepEqual(waves, [['o/r#21']]);
  assert.deepEqual(blocked, []);
});

test('fetchSpec keeps a genuine cross-branch blocker while dropping the ancestor edge', () => {
  // #31 (under epic #30) is blocked by sibling-branch epic #20 AND lists its own
  // parent #30. Only the ancestor edge is containment; the other expands.
  const gh = fakeGh({
    tree: {
      'o/r#1': [{ number: 20 }, { number: 30 }],
      'o/r#20': [{ number: 21 }],
      'o/r#30': [{ number: 31 }],
    },
    issues: { 20: issue(20), 21: issue(21), 30: issue(30), 31: issue(31) },
    blockedBy: { 'o/r#31': ['o/r#30', 'o/r#20'] },
  });
  const spec = fetchSpec('o/r', { epic: 1 }, gh);
  assert.deepEqual(spec.edges, [{ blocked: 'o/r#31', blockedBy: 'o/r#21' }]);
  const { waves } = planWaves(spec);
  assert.deepEqual(waves, [['o/r#21'], ['o/r#31']]);
});

test('fetchSpec expands a container edge onto a mix of open and closed leaves', () => {
  // Epic #20 holds open #21 and closed #22. "Blocked by #20" expands onto both;
  // the closed one must resolve into done rather than block #10 forever.
  const gh = fakeGh({
    tree: {
      'o/r#1': [{ number: 10 }, { number: 20 }],
      'o/r#20': [{ number: 21 }, { number: 22, state: 'CLOSED' }],
    },
    issues: { 10: issue(10, 'Blocked by #20'), 20: issue(20), 21: issue(21), 22: { state: 'CLOSED' } },
  });
  const spec = fetchSpec('o/r', { epic: 1 }, gh);
  assert.deepEqual(spec.nodes.map((n) => n.ref), ['o/r#10', 'o/r#21']);
  assert.deepEqual(spec.edges, [
    { blocked: 'o/r#10', blockedBy: 'o/r#21' },
    { blocked: 'o/r#10', blockedBy: 'o/r#22' },
  ]);
  assert.deepEqual(spec.done, ['o/r#22']);
  const { waves, blocked } = planWaves(spec);
  assert.deepEqual(waves, [['o/r#21'], ['o/r#10']]);
  assert.deepEqual(blocked, []);
});

test('fetchSpec ships an open epic whose children are all closed, rather than dropping it', () => {
  // Real shape from WXYC/Backend-Service#1543: epic #20 is open but its only
  // sub-issue is closed. It is not a grouping of pending work — it IS the
  // pending work, so it must become a node. Expanding it into nothing would
  // silently delete a shippable issue from the DAG.
  const gh = fakeGh({
    tree: {
      'o/r#1': [{ number: 10 }, { number: 20 }],
      'o/r#20': [{ number: 21, state: 'CLOSED' }],
    },
    issues: { 10: issue(10), 20: issue(20) },
  });
  const spec = fetchSpec('o/r', { epic: 1 }, gh);
  assert.deepEqual(spec.nodes.map((n) => n.ref).sort(), ['o/r#10', 'o/r#20']);
  const { waves } = planWaves(spec);
  assert.deepEqual(waves.flat().sort(), ['o/r#10', 'o/r#20']);
});

test('fetchSpec keeps an epic a container when its only open descendant is a demoted epic', () => {
  // #30's children are all closed so #30 ships; that makes #30 an open
  // descendant of #20, which therefore stays a grouping and does not ship.
  const gh = fakeGh({
    tree: {
      'o/r#1': [{ number: 20 }],
      'o/r#20': [{ number: 30 }],
      'o/r#30': [{ number: 31, state: 'CLOSED' }],
    },
    issues: { 20: issue(20), 30: issue(30) },
  });
  const spec = fetchSpec('o/r', { epic: 1 }, gh);
  assert.deepEqual(spec.nodes.map((n) => n.ref), ['o/r#30']);
});

test('fetchSpec preserves a leaf self-edge so it still surfaces as a cycle', () => {
  // An issue naming itself as its own blocker is corrupt input, and the core
  // reports it as `cyclic`. The self-pair guard in the expansion exists to drop
  // pairs the *expansion* invented, not to erase that signal — silently shipping
  // an issue whose own body says it is blocked is the wrong kind of quiet.
  const gh = fakeGh({
    tree: { 'o/r#1': [{ number: 10 }, { number: 20 }], 'o/r#20': [{ number: 21 }] },
    issues: { 10: issue(10, 'Blocked by #10'), 20: issue(20), 21: issue(21) },
  });
  const spec = fetchSpec('o/r', { epic: 1 }, gh);
  assert.deepEqual(spec.edges, [{ blocked: 'o/r#10', blockedBy: 'o/r#10' }]);
  const { waves, cyclic } = planWaves(spec);
  assert.deepEqual(cyclic, ['o/r#10']);
  assert.deepEqual(waves, [['o/r#21']]);
});

test('fetchSpec pushes a container blocker down onto a demoted all-closed epic', () => {
  // #20 ships in its children's place, so a blocker declared on its parent epic
  // #2 must reach it — the demotion must not sever the push-down.
  const gh = fakeGh({
    tree: {
      'o/r#1': [{ number: 10 }, { number: 2 }],
      'o/r#2': [{ number: 20 }],
      'o/r#20': [{ number: 21, state: 'CLOSED' }],
    },
    issues: { 10: issue(10), 2: issue(2, 'Blocked by #10'), 20: issue(20) },
  });
  const spec = fetchSpec('o/r', { epic: 1 }, gh);
  assert.deepEqual(spec.nodes.map((n) => n.ref), ['o/r#10', 'o/r#20']);
  assert.deepEqual(spec.edges, [{ blocked: 'o/r#20', blockedBy: 'o/r#10' }]);
  const { waves } = planWaves(spec);
  assert.deepEqual(waves, [['o/r#10'], ['o/r#20']]);
});

test('a relative CO_HOME that cannot load names the absolute core path in the error', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./scripts/plan-waves.mjs')"], {
    cwd: resolve(import.meta.dirname, '..'), env: { ...process.env, CO_HOME: 'no-such-checkout' }, encoding: 'utf8',
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, new RegExp(`from ${resolve(import.meta.dirname, '..', 'no-such-checkout', 'dist/src/index.js').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`));
});

// A ship-dag wave sub-epic (label `ship-dag-wave`) groups one wave's issues. It
// is never work itself, and closing it must never hide an issue still under it.
const WAVE = [WAVE_LABEL];
for (const { name, tree, issues, nodes, warns, edges = [], done = [] } of [
  {
    name: 'an open wave sub-epic whose children all closed ships nothing, and warns',
    tree: { 'o/r#1': [{ number: 20, labels: WAVE }], 'o/r#20': [{ number: 21, state: 'CLOSED' }] },
    issues: { 20: issue(20) },
    nodes: [],
    warns: [/o\/r#20.*wave sub-epic/],
  },
  {
    name: 'a wave sub-epic whose sub-issue query fails ships nothing, not even itself',
    tree: { 'o/r#1': [{ number: 20, labels: WAVE }, { number: 10 }], 'o/r#20': null },
    issues: { 10: issue(10) },
    nodes: ['o/r#10'],
    warns: [/wave sub-epic o\/r#20.*shipping nothing/],
  },
  {
    name: 'an edge naming a held-back wave sub-epic is satisfied, not an external blocker',
    tree: { 'o/r#1': [{ number: 20, labels: WAVE }, { number: 10 }], 'o/r#20': [{ number: 21, state: 'CLOSED' }] },
    issues: { 10: issue(10, 'Blocked by #20') },
    nodes: ['o/r#10'],
    warns: [/o\/r#20.*wave sub-epic/],
    edges: [{ blocked: 'o/r#10', blockedBy: 'o/r#20' }],
    done: ['o/r#20'],
  },
  {
    name: 'an empty open wave sub-epic ships nothing, and warns',
    tree: { 'o/r#1': [{ number: 20, labels: WAVE }, { number: 10 }] },
    issues: { 10: issue(10), 20: issue(20) },
    nodes: ['o/r#10'],
    warns: [/o\/r#20.*wave sub-epic/],
  },
  {
    name: 'a closed wave sub-epic with an open child ships the child, and warns',
    tree: { 'o/r#1': [{ number: 20, labels: WAVE, state: 'CLOSED' }], 'o/r#20': [{ number: 21 }, { number: 22, state: 'CLOSED' }] },
    issues: { 20: issue(20), 21: issue(21) },
    nodes: ['o/r#21'],
    warns: [/o\/r#20.*closed.*o\/r#21/],
  },
  {
    name: 'a closed wave sub-epic whose children all closed ships nothing, quietly',
    tree: { 'o/r#1': [{ number: 20, labels: WAVE, state: 'CLOSED' }, { number: 10 }], 'o/r#20': [{ number: 21, state: 'CLOSED' }] },
    issues: { 10: issue(10) },
    nodes: ['o/r#10'],
    warns: [],
  },
  {
    name: 'an open wave sub-epic with an open child ships the child',
    tree: { 'o/r#1': [{ number: 20, labels: WAVE }], 'o/r#20': [{ number: 21 }] },
    issues: { 20: issue(20), 21: issue(21, 'Blocked by #20') },
    nodes: ['o/r#21'],
    warns: [],
  },
  {
    name: 'an unlabelled open epic whose children all closed still ships as itself',
    tree: { 'o/r#1': [{ number: 20 }], 'o/r#20': [{ number: 21, state: 'CLOSED' }] },
    issues: { 20: issue(20) },
    nodes: ['o/r#20'],
    warns: [],
  },
  {
    name: 'an unlabelled empty open sub-issue still ships as itself',
    tree: { 'o/r#1': [{ number: 20 }] },
    issues: { 20: issue(20) },
    nodes: ['o/r#20'],
    warns: [],
  },
  {
    name: 'an unlabelled closed epic still takes its open children out of scope',
    tree: { 'o/r#1': [{ number: 20, state: 'CLOSED' }, { number: 10 }], 'o/r#20': [{ number: 21 }] },
    issues: { 10: issue(10) },
    nodes: ['o/r#10'],
    warns: [],
  },
]) {
  test(`fetchSpec: ${name}`, () => {
    const seen = [];
    const spec = fetchSpec('o/r', { epic: 1, warn: (m) => seen.push(m) }, fakeGh({ tree, issues }));
    assert.deepEqual(spec.nodes.map((n) => n.ref), nodes);
    assert.deepEqual(spec.edges, edges);
    assert.deepEqual(spec.done, done);
    assert.equal(seen.length, warns.length, `warnings: ${JSON.stringify(seen)}`);
    warns.forEach((re, i) => assert.match(seen[i], re));
  });
}

// ---- members: every leaf in scope, closed ones included ------------------

for (const [name, tree, opens, members] of [
  ['a closed leaf is a member though not a node',
    { 'o/r#1': [{ number: 10 }, { number: 11, state: 'CLOSED' }] }, [10], ['o/r#10', 'o/r#11']],
  ['a closed sub-epic is out of scope, and so are its children',
    { 'o/r#1': [{ number: 10 }, { number: 20, state: 'CLOSED' }], 'o/r#20': [{ number: 21 }] }, [10], ['o/r#10']],
  ['an open epic whose children are all closed contributes itself and them',
    { 'o/r#1': [{ number: 10 }, { number: 20 }], 'o/r#20': [{ number: 21, state: 'CLOSED' }] }, [10, 20],
    ['o/r#10', 'o/r#20', 'o/r#21']],
  ['an open container is not a member, its leaves are',
    { 'o/r#1': [{ number: 20 }], 'o/r#20': [{ number: 21 }, { number: 22, state: 'CLOSED' }] }, [20, 21],
    ['o/r#21', 'o/r#22']],
  ['a closed cross-repo leaf keeps its own repo',
    { 'o/r#1': [{ number: 10 }, { number: 4, repo: 'x/y', state: 'CLOSED' }] }, [10], ['o/r#10', 'x/y#4']],
  // A wave sub-epic only groups one wave's issues: those are real work and count,
  // closed or not, while the grouping itself never does.
  ['a closed wave sub-epic whose children all closed: they are members, the wave is not',
    { 'o/r#1': [{ number: 20, labels: WAVE, state: 'CLOSED' }, { number: 10 }], 'o/r#20': [{ number: 21, state: 'CLOSED' }, { number: 22, state: 'CLOSED' }] },
    [10], ['o/r#10', 'o/r#21', 'o/r#22']],
  ['a closed wave sub-epic with an open child: both children are members, the wave is not',
    { 'o/r#1': [{ number: 20, labels: WAVE, state: 'CLOSED' }], 'o/r#20': [{ number: 21 }, { number: 22, state: 'CLOSED' }] },
    [20, 21], ['o/r#21', 'o/r#22']],
  ['an open wave sub-epic held back with every child closed: the children are members, the wave is not',
    { 'o/r#1': [{ number: 20, labels: WAVE }], 'o/r#20': [{ number: 21, state: 'CLOSED' }] }, [20], ['o/r#21']],
  ['an empty closed wave sub-epic is not a member',
    { 'o/r#1': [{ number: 20, labels: WAVE, state: 'CLOSED' }, { number: 10 }] }, [10], ['o/r#10']],
]) {
  // `opens` lists every open issue the walk reads, containers included (they are
  // read for their edges); `members` is the expected leaf set.
  test(`fetchSpec members: ${name}`, () => {
    const gh = fakeGh({ tree, issues: Object.fromEntries(opens.map((n) => [n, issue(n)])) });
    const spec = fetchSpec('o/r', { epic: 1, members: true, warn: () => {} }, gh);
    assert.deepEqual([...spec.members].sort(), members);
  });
}

test('fetchSpec members on the label path adds the closed listing to the open one', () => {
  const gh = fakeGh({ list: [{ number: 5 }], closedList: [{ number: 3 }], issues: { 5: issue(5) } });
  const spec = fetchSpec('o/r', { label: 'ship', members: true }, gh);
  assert.deepEqual([...spec.members].sort(), ['o/r#3', 'o/r#5']);
  assert.deepEqual(spec.nodes.map((n) => n.ref), ['o/r#5'], 'a closed issue never becomes a node');
  const closedCall = gh.calls.find((a) => a[1] === 'list' && a.includes('closed'));
  assert.ok(closedCall.includes('--limit'), 'the closed listing is capped like the open one');
});

test('fetchSpec warns through warn when the closed label listing hits the cap', () => {
  const seen = [];
  const full = Array.from({ length: 1000 }, (_, i) => ({ number: i + 100 }));
  fetchSpec('o/r', { label: 'ship', members: true, warn: (m) => seen.push(m) }, fakeGh({ list: [], closedList: full, issues: {} }));
  assert.equal(seen.length, 1);
  assert.match(seen[0], /closed issue list hit the 1000 cap; the status board's members may be undercounted/);
  assert.doesNotMatch(seen[0], /DAG/, 'closed issues are never nodes, so the DAG itself is whole');
});

test('fetchSpec without members makes only the open label listing and emits no members', () => {
  const gh = fakeGh({ list: [{ number: 5 }], closedList: [{ number: 3 }], issues: { 5: issue(5) } });
  const spec = fetchSpec('o/r', { label: 'ship' }, gh);
  assert.equal('members' in spec, false);
  const lists = gh.calls.filter((a) => a[0] === 'issue' && a[1] === 'list');
  assert.deepEqual(lists.map((a) => a[a.indexOf('--state') + 1]), ['open']);
});

test('fetchSpec without members emits no members on the epic path', () => {
  const gh = fakeGh({ tree: { 'o/r#1': [{ number: 10 }, { number: 11, state: 'CLOSED' }] }, issues: { 10: issue(10) } });
  assert.equal('members' in fetchSpec('o/r', { epic: 1 }, gh), false);
});

for (const [argv, want] of [
  [['--repo', 'o/r', '--epic', '7'], { repo: 'o/r', epic: '7' }],
  [['--repo', 'o/r', '--label', 'ship', '--members'], { repo: 'o/r', label: 'ship', members: true }],
]) {
  test(`parseFetchArgs ${argv.join(' ')}`, () => assert.deepEqual(parseFetchArgs(argv), want));
}

// A typo must not silently drop a flag, and a flag must not be read as another flag's value.
for (const [argv, want] of [
  [['--repo', 'o/r', '--label', 'ship', '--member'], /unknown argument: --member$/],
  [['--repo', 'o/r', '--label', 'ship', '--members=true'], /unknown argument: --members=true/],
  [['--repo', 'o/r', '--epic', '7', '8'], /unknown argument: 8/],
  [['--repo', 'o/r', '--epic', '--members'], /--epic requires a value/],
  [['--repo', 'o/r', '--label'], /--label requires a value/],
]) {
  test(`parseFetchArgs rejects ${argv.join(' ')}`, () => assert.throws(() => parseFetchArgs(argv), want));
}

test('planWaves ignores members', () => {
  const spec = { repo: 'o/r', nodes: [5, 6], edges: [{ blocked: 6, blockedBy: 5 }], done: [] };
  assert.deepEqual(planWaves({ ...spec, members: ['o/r#3', 'o/r#5', 'o/r#6'] }), planWaves(spec));
});
