// Tests for the DAG planner. Run: node --test skills/ship-dag/scripts/
//
// The graph math itself lives in (and is tested by) the shared topo core in
// claude-orchestrator; these tests cover the ship-dag layer: spec→ref conversion
// and delegation, cross-repo body-edge parsing, and the gh-fetch wrapper.
// Everything the planner emits is keyed on composite refs ("owner/repo#N", or a
// bare "N" in single-repo back-compat).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWaves, readySet, bodyEdges, fetchSpec } from './plan-waves.mjs';

// A fake `gh` runner: branches on argv so fetchSpec is testable without network.
// Records every invocation on `.calls` so tests can assert repo routing.
function fakeGh(fixtures) {
  const calls = [];
  const run = (argv) => {
    calls.push(argv);
    if (argv[0] === 'issue' && argv[1] === 'list') return JSON.stringify(fixtures.list || []);
    if (argv[0] === 'issue' && argv[1] === 'view') {
      const n = Number(argv[2]);
      if (!fixtures.issues[n]) throw new Error(`no such issue #${n}`);
      return JSON.stringify(fixtures.issues[n]);
    }
    if (argv[0] === 'api' && argv[1] === 'graphql') return JSON.stringify(fixtures.graphql);
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
