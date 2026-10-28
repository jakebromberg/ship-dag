// Tests for the board CLI. Runs are real dirs built through the shared engine fixture; `gh` is a fake that answers
// the CLI's batched GraphQL queries from a table of issues and records every query it is asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CLOSURE_CAP, main } from './board.mjs';
import { ghExecError, graphqlAnswer, restFailure } from './lib/gh-fixture.mjs';
import { RUN, T0, T1, engineConfig, scopedEngineFixture, stamped } from './lib/engine-fixture.mjs';
import { parseRef } from './lib/ref.mjs';
import { artifactStem } from './lib/failure.mjs';
import { docLine } from './lib/doc-pins.mjs';
import { appendRecord } from './telemetry.mjs';

const R = (n) => `o/r#${n}`;
const NOW = new Date('2026-10-08T20:30:00.000Z');
const STARTED = '2026-10-08T12:00:00.000Z';
const BOARD = { runId: RUN, title: 'Invented board', issueSet: {}, blockOn: ['correctness'], startedAt: STARTED };
const SPEC = { nodes: [{ ref: R(1) }, { ref: R(2) }], edges: [{ blocked: R(2), blockedBy: R(1) }], done: [R(9)] };

/** A base dir holding the run's family: `RUN` (a config for refs 1 and 2, `files` beside it, one left undefined is left out) and any `siblings`. */
function setUp({ files = {}, siblings = {}, reviews = [] } = {}) {
  const fx = scopedEngineFixture({
    [`ship-dag/engine/${RUN}`]: {
      configs: { 'config.json': stamped(T0, engineConfig([R(1), R(2)], { configDir: `/x/${RUN}/state` })) },
      files: Object.fromEntries(Object.entries({ 'board.json': BOARD, 'dag.json': SPEC, ...files }).filter(([, body]) => body !== undefined)),
      reviews,
    },
    ...siblings,
  });
  const dir = fx.dirs[`ship-dag/engine/${RUN}`];
  return { ...fx, dir, env: { XDG_STATE_HOME: fx.base, HOME: '/nope', SHIP_DAG_TELEMETRY: join(fx.base, 'runs.jsonl') } };
}

const WIRE = /repository\(owner:"([^"]+)",name:"([^"]+)"\)\{issue\(number:(\d+)\)/g;

/**
 * A fake `gh api graphql` over `table` (ref → `{state, stateReason, closedAt, prs, blockers}`, a blocker being a ref whose
 * `blockedBy` node carries its row's state, stateReason and closedAt, and a `parent` ref whose own row may name a parent;
 * `{missing: true}` for an issue GitHub does not have, or `{missing: 410}` for a deleted one (403: one the token cannot read); `{moved: ref}` for one
 * transferred to `ref`; `{pull: true}` for a number that is a pull request): answers each aliased lookup as gh 2.102.0
 * does (`graphqlAnswer`: a NOT_FOUND alias makes gh exit 1 with the body on stdout), answers the REST
 * `repos/<repo>/issues/<n>` read of a missing, moved or pull row as GitHub does (a 404 or 410, or the issue at its
 * new `html_url`), throws on a ref the table lacks, and records each GraphQL query's refs in `calls` and each REST
 * ref in `rest`.
 */
function fakeGh(table) {
  const calls = [];
  const rest = [];
  const stateOf = (ref) => table[ref]?.state ?? 'OPEN';
  /** `ref`'s issue as a `parent` selection, its own parent from its table row, or null for none. */
  const parentNode = (ref) => (ref ? { number: parseRef(ref).number, title: `Title ${parseRef(ref).number}`, url: `https://github.com/${parseRef(ref).repo}/issues/${parseRef(ref).number}`,
    repository: { nameWithOwner: parseRef(ref).repo }, parent: parentNode(table[ref]?.parent) } : null);
  const runGh = async (args) => {
    const path = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(args[1]);
    if (args[0] === 'api' && path) {
      const ref = `${path[1]}#${path[2]}`;
      const row = table[ref] ?? {};
      rest.push(ref);
      if (row.missing) {
        const status = row.missing === true ? 404 : row.missing;
        throw restFailure(status, { 403: 'Resource not accessible by integration', 410: 'This issue was deleted' }[status] ?? 'Not Found', args);
      }
      if (row.moved) { const to = parseRef(row.moved); return JSON.stringify({ number: to.number, html_url: `https://github.com/${to.repo}/issues/${to.number}` }); }
      if (row.pull) return JSON.stringify({ number: Number(path[2]), html_url: `https://github.com/${path[1]}/pull/${path[2]}` });
      throw new Error(`unexpected REST read of ${ref}`);
    }
    assert.deepEqual(args.slice(0, 2), ['api', 'graphql']);
    const refs = [...args.find((a) => a.startsWith('query=')).matchAll(WIRE)].map(([, owner, name, n]) => `${owner}/${name}#${n}`);
    calls.push(refs);
    const errors = [];
    const data = Object.fromEntries(refs.map((ref, i) => {
      const row = table[ref];
      if (!row) throw new Error(`unexpected lookup of ${ref}`);
      const { number, repo } = parseRef(ref);
      if (row.missing || row.moved || row.pull) {
        errors.push({ type: 'NOT_FOUND', path: [`r${i}`, 'issue'], message: `Could not resolve to an Issue with the number of ${number}.` });
        return [`r${i}`, { issue: null }];
      }
      return [`r${i}`, { issue: {
        number, title: `Title ${number}`, url: `https://github.com/${repo}/issues/${number}`, state: row.state ?? 'OPEN',
        stateReason: row.stateReason ?? null, closedAt: row.closedAt ?? null, ...(row.createdAt && { createdAt: row.createdAt }),
        ...(row.labels && { labels: { nodes: row.labels.map((name) => ({ name })) } }), parent: parentNode(row.parent),
        closedByPullRequestsReferences: { nodes: (row.prs ?? []).map((p) => ({ url: `https://github.com/${repo}/pull/${p.number}`, ...p })) },
        blockedBy: { nodes: (row.blockers ?? []).map((b) => ({ number: parseRef(b).number, state: stateOf(b), stateReason: table[b]?.stateReason ?? null, closedAt: table[b]?.closedAt ?? null, repository: { nameWithOwner: parseRef(b).repo } })) },
      } }];
    }));
    return graphqlAnswer(errors.length ? { data, errors } : { data });
  };
  return { runGh, calls, rest };
}

/** Run the CLI; returns `{code, err, html}` (`html` is `board.html` in `dir`, or null). */
async function run(argv, { env, dir, runGh = async () => { throw new Error('no gh expected'); } }) {
  const err = [];
  const code = await main(argv, { runGh, env, now: () => NOW, log: (m) => err.push(m), sleep: async () => {} });
  const path = join(dir, 'board.html');
  return { code, err, html: existsSync(path) ? readFileSync(path, 'utf8') : null };
}

const BEFORE_RUN = '2026-10-08T11:00:00.000Z'; // before STARTED
const DURING_RUN = '2026-10-08T14:00:00.000Z'; // after STARTED, before NOW
const TABLE = { [R(1)]: {}, [R(2)]: {}, [R(9)]: { state: 'CLOSED', closedAt: '2026-10-08T13:00:00.000Z' } };

test('render writes board.html beside board.json; a closed member with no edges counts as shipped, and nodes ∪ done are the members', async () => {
  const s = setUp();
  const { runGh } = fakeGh(TABLE);
  const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh });
  assert.equal(code, 0, err.join('\n'));
  assert.match(html, /<b>1\/3<\/b><span>shipped<\/span>/);
  assert.match(html, /Invented board/);
  assert.match(html, /wave 1/, 'the wave comes from the run family');
  assert.ok(err.some((m) => m.startsWith('[board] wrote ')), err.join('\n'));
  assert.deepEqual(readdirSync(s.dir).filter((f) => f.includes('.tmp')), []);
});

test('a spec with members counts those, not nodes ∪ done', async () => {
  const s = setUp({ files: { 'dag.json': { ...SPEC, members: [R(1), R(2)] } } });
  const { code, html } = await run(['render', '--run-id', RUN], { ...s, runGh: fakeGh(TABLE).runGh });
  assert.equal(code, 0);
  assert.match(html, /<b>0\/2<\/b><span>shipped<\/span>/);
});

test('lookups go 40 refs to a query', async () => {
  const nodes = Array.from({ length: 85 }, (_, i) => ({ ref: R(100 + i) }));
  const s = setUp({ files: { 'dag.json': { nodes, edges: [], done: [] } } });
  const gh = fakeGh({ ...TABLE, ...Object.fromEntries(nodes.map((n) => [n.ref, {}])) });
  const { code } = await run(['render', '--run-id', RUN], { ...s, runGh: gh.runGh });
  assert.equal(code, 0);
  assert.deepEqual(gh.calls.map((c) => c.length), [40, 40, 7]); // the 85 nodes and the wave's refs 1 and 2
});

test('an open blocker outside the set is looked up in a closure round, a closed one that shipped before the run is not, and its dependent is drawn in a step', async () => {
  const s = setUp();
  const gh = fakeGh({ ...TABLE, [R(2)]: { blockers: [R(7), R(8)] }, [R(7)]: { blockers: [R(6)] }, [R(6)]: { state: 'CLOSED' }, [R(8)]: { state: 'CLOSED', closedAt: BEFORE_RUN } });
  const { code, html } = await run(['render', '--run-id', RUN], { ...s, runGh: gh.runGh });
  assert.equal(code, 0);
  assert.deepEqual(gh.calls.map((c) => c.sort()), [[R(1), R(2), R(9)], [R(7)]]);
  assert.doesNotMatch(html, /Can't be ordered/, 'the dependent is drawn in a step now (issue #515)');
  assert.match(html, /<div class="node s-outside[ "][^>]*data-ref="o\/r#7"/);
});

// The outside blocker the closure read is drawn, and counted in the required set beside the run's tickets (issues #515, #522).
test('an outside blocker is a node of its own, counted in the totals beside the run\'s tickets (issues #515, #522)', async () => {
  const s = setUp();
  const gh = fakeGh({ ...TABLE, [R(2)]: { blockers: [R(7)] }, [R(7)]: {} });
  const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh: gh.runGh });
  assert.equal(code, 0, err.join('\n'));
  assert.match(html, /<b>3 tickets left: 2 in this run, 1 outside it; in 2 steps\.<\/b>/, 'the summary counts the required set (issue #522)');
  assert.match(html, /<b>1\/4<\/b><span>shipped<\/span>/, 'the headline counts the run\'s three tickets and the one outside (issue #522)');
  assert.match(html, /<b>1<\/b><span>open outside this run<\/span>/);
  assert.ok(err.some((m) => m.endsWith('(3 tickets)')), err.join('\n'));
  assert.match(html, /<div class="t" title="Title 7">Title 7<\/div>/, 'the node shows the title the closure read');
});

// The outside refs join the repo list the short labels come from: two owners' `r` repos need their owners (issue #515).
test('an outside blocker\'s repo counts when short labels are made, so a repo name shared with another owner stays unambiguous (issue #515)', async () => {
  const s = setUp();
  const gh = fakeGh({ ...TABLE, [R(2)]: { blockers: ['p/r#7'] }, 'p/r#7': {} });
  const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh: gh.runGh });
  assert.equal(code, 0, err.join('\n'));
  assert.ok(html.includes('>p/r#7</a>'), 'the outside ref carries its owner');
  assert.ok(html.includes('>o/r#1</a>'), 'and so does the run\'s own');
});

// An outside node is kept only while an orderable ticket of the run waits behind it (issue #515).
/** `n` outside blockers chained from r#`from`: each waits on the next, and the last on nothing. */
const chain = (from, n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [R(from + i), i < n - 1 ? { blockers: [R(from + i + 1)] } : {}]));
// r#10 … r#109 chained: one more than the cap's 99 levels, so the closure stops and leaves r#109 unread.
const PAST_CAP = chain(10, CLOSURE_CAP);

for (const [name, table] of [
  ['a cycle through it', { [R(2)]: { blockers: [R(7)] }, [R(7)]: { blockers: [R(2)] } }],
  ['a blocker the closure never read', { [R(2)]: { blockers: [R(10)] }, ...PAST_CAP }],
  ['a blocker of its own that the closure never read, behind its only dependent', { [R(2)]: { blockers: [R(7), R(10)] }, [R(7)]: {}, ...PAST_CAP }],
]) {
  test(`an outside blocker with no orderable dependent is not drawn, and its run ticket is in the callout: ${name} (issue #515)`, async () => {
    const s = setUp();
    const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh: fakeGh({ ...TABLE, ...table }).runGh });
    assert.equal(code, 0, err.join('\n'));
    assert.doesNotMatch(html, /data-ref="o\/r#(7|\d{2,3})"/, 'no outside node');
    assert.doesNotMatch(html, /plus \d+ open blockers? outside this run/);
    const callout = html.slice(html.indexOf("Can't be ordered"), html.indexOf('Longest chain'));
    assert.ok(callout.includes('r#2'), 'the run ticket behind it is listed');
    assert.ok(!/r#(7|\d{2,3})</.test(callout), 'and so is nothing outside the run');
  });
}

// Neither the run's own epic nor the open blocker of a member that already closed is a blocker of anything open (issue #515).
test('with an epic issue set, neither the epic nor an open blocker of a closed member becomes an outside node (issue #515)', async () => {
  const s = setUp({ files: { 'board.json': { ...BOARD, issueSet: { epic: R(50) } } } });
  const table = { ...TABLE, [R(50)]: { blockers: [R(61)] }, [R(61)]: {}, [R(9)]: { state: 'CLOSED', closedAt: '2026-10-08T13:00:00.000Z', blockers: [R(60)] }, [R(60)]: {} };
  const gh = fakeGh(table);
  const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh: gh.runGh });
  assert.equal(code, 0, err.join('\n'));
  assert.deepEqual(gh.calls.flat().filter((r) => r === R(60) || r === R(61)), [], 'the closure follows only open tickets other than the epic, so neither chain is read (issue #522)');
  assert.doesNotMatch(html, /data-ref="o\/r#(50|60)"/);
  assert.doesNotMatch(html, /plus \d+ open blockers? outside/);
  assert.doesNotMatch(html, /Can't be ordered/);
});

test('a chain of outside blockers deeper than five is read and drawn whole (issue #522)', async () => {
  const s = setUp();
  const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh: fakeGh({ ...TABLE, [R(2)]: { blockers: [R(10)] }, ...chain(10, 12) }).runGh });
  assert.equal(code, 0, err.join('\n'));
  for (let n = 10; n < 22; n += 1) assert.match(html, new RegExp(`data-ref="o/r#${n}"`), `r#${n} is drawn`);
  assert.doesNotMatch(html, /Can't be ordered/);
  assert.ok(!err.some((m) => /closure/.test(m)), err.join('\n'));
});

for (const [name, depth, warns] of [['a chain of 99 reads whole, silently', CLOSURE_CAP - 1, false], ['a chain of 100 hits the cap and says so', CLOSURE_CAP, true]]) {
  test(`the closure runs to a fixed point under a safety cap of ${CLOSURE_CAP} rounds: ${name} (issue #522)`, async () => {
    const s = setUp({ files: { 'dag.json': { nodes: [{ ref: R(1) }], edges: [], done: [] } } });
    const gh = fakeGh({ ...TABLE, [R(1)]: { blockers: [R(10)] }, ...chain(10, depth) });
    const { code, err } = await run(['render', '--run-id', RUN], { ...s, runGh: gh.runGh });
    assert.equal(code, 0, err.join('\n'));
    assert.equal(gh.calls.length, CLOSURE_CAP, 'round 0 and one round per level, up to the cap');
    const cap = err.filter((m) => /closure/.test(m));
    assert.deepEqual(cap, warns ? [`[board] closure hit its safety cap of ${CLOSURE_CAP} rounds; 1 open blocker unread`] : []);
  });
}

// ---- the required set: closed outside blockers (issue #522) ----

/** The Shipped section's table body. */
const shippedRows = (html) => html.slice(html.indexOf('<h2>Shipped'), html.indexOf('</details>', html.indexOf('<h2>Shipped')));

for (const [name, row, counted] of [
  ['one closed after the run started counts as shipped, marked outside', { state: 'CLOSED', closedAt: DURING_RUN }, true],
  ['one closed before the run started is history, and is not read', { state: 'CLOSED', closedAt: BEFORE_RUN }, false],
  ['one closed without shipping after the run started is not counted, and is not read', { state: 'CLOSED', stateReason: 'NOT_PLANNED', closedAt: DURING_RUN }, false],
  ['one closed with no closedAt is not counted, and is not read', { state: 'CLOSED' }, false],
]) {
  test(`a closed outside blocker of an open run ticket: ${name} (issue #522)`, async () => {
    const s = setUp();
    const gh = fakeGh({ ...TABLE, [R(2)]: { blockers: [R(8)] }, [R(8)]: row });
    const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh: gh.runGh });
    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(gh.calls.map((c) => c.sort()), counted ? [[R(1), R(2), R(9)], [R(8)]] : [[R(1), R(2), R(9)]]);
    assert.match(html, counted ? /<b>2\/4<\/b><span>shipped<\/span>/ : /<b>1\/3<\/b><span>shipped<\/span>/);
    const rows = shippedRows(html);
    assert.equal(rows.includes('issues/8"'), counted, rows);
    if (counted) assert.match(rows, /Title 8 <span class="owner">outside this run · no epic · not scheduled<\/span>/);
    assert.match(html, counted ? /<h2>Shipped <small>2 tickets, newest first/ : /<h2>Shipped <small>1 ticket, newest first/);
  });
}

for (const [name, when, counted] of [['after', DURING_RUN, true], ['before', BEFORE_RUN, false]]) {
  test(`a closed outside blocker named by a spec edge is read in round 0, and counts only when it closed ${name} the run started (issue #522)`, async () => {
    const s = setUp({ files: { 'dag.json': { ...SPEC, edges: [...SPEC.edges, { blocked: R(2), blockedBy: R(8) }] } } });
    const gh = fakeGh({ ...TABLE, [R(8)]: { state: 'CLOSED', closedAt: when } });
    const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh: gh.runGh });
    assert.equal(code, 0, err.join('\n'));
    assert.equal(gh.calls.length, 1);
    assert.match(html, counted ? /<b>2\/4<\/b>/ : /<b>1\/3<\/b>/);
  });
}

test('a closed outside ticket is a leaf: its own blockers, open or closed, are never read (issue #522)', async () => {
  const s = setUp({ files: { 'dag.json': { ...SPEC, edges: [...SPEC.edges, { blocked: R(2), blockedBy: R(31) }] } } });
  const gh = fakeGh({ ...TABLE, [R(2)]: { blockers: [R(8)] }, [R(8)]: { state: 'CLOSED', closedAt: DURING_RUN, blockers: [R(30), R(32)] }, [R(30)]: {},
    [R(31)]: { state: 'CLOSED', closedAt: DURING_RUN, blockers: [R(33)] }, [R(32)]: { state: 'CLOSED', closedAt: DURING_RUN }, [R(33)]: {} });
  const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh: gh.runGh });
  assert.equal(code, 0, err.join('\n'));
  for (const ref of [R(30), R(32), R(33)]) assert.ok(!gh.calls.flat().includes(ref), `${ref} is read: ${JSON.stringify(gh.calls)}`);
  assert.doesNotMatch(html, /data-ref="o\/r#3[03]"/);
  assert.match(html, /<b>3\/5<\/b>/, 'r#9, and the leaves r#8 and r#31');
});

test('a shipped run ticket\'s closed outside blocker, closed after the run started, counts too (issue #522)', async () => {
  const s = setUp();
  const gh = fakeGh({ ...TABLE, [R(9)]: { ...TABLE[R(9)], blockers: [R(8)] }, [R(8)]: { state: 'CLOSED', closedAt: DURING_RUN } });
  const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh: gh.runGh });
  assert.equal(code, 0, err.join('\n'));
  assert.match(html, /<b>2\/4<\/b>/);
});

test('a closed outside blocker of an open outside ticket counts; one behind an outside ticket the board cannot place does not (issue #522)', async () => {
  const s = setUp({ files: { 'dag.json': { ...SPEC, edges: [] } } }); // r#2 must not wait on r#1, whose cycle with r#40 leaves it unorderable
  const gh = fakeGh({ ...TABLE, [R(2)]: { blockers: [R(7)] }, [R(7)]: { blockers: [R(8)] }, [R(8)]: { state: 'CLOSED', closedAt: DURING_RUN },
    [R(1)]: { blockers: [R(40)] }, [R(40)]: { blockers: [R(1), R(41)] }, [R(41)]: { state: 'CLOSED', closedAt: DURING_RUN } });
  const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh: gh.runGh });
  assert.equal(code, 0, err.join('\n'));
  assert.ok(shippedRows(html).includes('issues/8"'));
  assert.ok(!shippedRows(html).includes('issues/41"'), 'r#40 sits in a cycle with r#1, so it is not drawn, and its leaf is not counted');
});

test('the closure reads a closed leaf past the cap\'s last open level without warning (issue #522)', async () => {
  const s = setUp({ files: { 'dag.json': { nodes: [{ ref: R(1) }], edges: [], done: [] } } });
  const rows = chain(10, CLOSURE_CAP - 1);
  rows[R(10 + CLOSURE_CAP - 2)] = { blockers: [R(500)] };
  const gh = fakeGh({ ...TABLE, [R(1)]: { blockers: [R(10)] }, ...rows, [R(500)]: { state: 'CLOSED', closedAt: DURING_RUN } });
  const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh: gh.runGh });
  assert.equal(code, 0, err.join('\n'));
  assert.ok(!err.some((m) => /closure/.test(m)), err.join('\n'));
  assert.equal(gh.calls.length, CLOSURE_CAP + 1, 'the leaf takes one round past the cap');
  assert.ok(shippedRows(html).includes('issues/500"'));
});

test('at the cap the closure still reads the closed leaves due that round, and counts them (issue #522 review)', async () => {
  const s = setUp({ files: { 'dag.json': { nodes: [{ ref: R(1) }, { ref: R(2) }], edges: [], done: [] } } });
  const a = chain(10, CLOSURE_CAP - 1); // r#10 … r#108, read whole by round 99
  a[R(10 + CLOSURE_CAP - 2)] = { blockers: [R(500)] };
  const gh = fakeGh({ ...TABLE, [R(1)]: { blockers: [R(10)] }, [R(2)]: { blockers: [R(200)] }, ...a, ...chain(200, CLOSURE_CAP), [R(500)]: { state: 'CLOSED', closedAt: DURING_RUN } });
  const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh: gh.runGh });
  assert.equal(code, 0, err.join('\n'));
  assert.ok(err.includes(`[board] closure hit its safety cap of ${CLOSURE_CAP} rounds; 1 open blocker unread`), err.join('\n'));
  assert.deepEqual(gh.calls[CLOSURE_CAP], [R(500)], 'the last round reads the leaf alone');
  assert.ok(shippedRows(html).includes('issues/500"'));
});

test('a board.json startedAt that is not a date warns that closed outside blockers are not counted (issue #522 review)', async () => {
  const s = setUp({ files: { 'board.json': { ...BOARD, startedAt: 'yesterday' } } });
  const { code, err } = await run(['render', '--run-id', RUN], { ...s, runGh: fakeGh({ ...TABLE, [R(2)]: { blockers: [R(8)] }, [R(8)]: { state: 'CLOSED', closedAt: DURING_RUN } }).runGh });
  assert.equal(code, 0, err.join('\n'));
  assert.ok(err.some((m) => /startedAt .*not a date.*closed outside blockers are not counted/.test(m)), err.join('\n'));
});

test('a milestone counts the open outside tickets before it beside the run\'s (issue #522)', async () => {
  const s = setUp();
  const gh = fakeGh({ ...TABLE, [R(2)]: { blockers: [R(7)], labels: ['hitl-gate'] }, [R(7)]: {} });
  const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh: gh.runGh });
  assert.equal(code, 0, err.join('\n'));
  assert.match(html, /2 open tickets before it: 1 in this run, 1 outside it \(<a href="https:\/\/github.com\/o\/r\/issues\/7">r#7<\/a> — no epic · not scheduled\)/);
});

// ---- the owner label: each outside ticket's top epic and the run shipping it (issue #522) ----

const OTHER = 'sd-20261001-090000'; // another run, in the same engine base dir
const sidecarIn = (runId, refs, emittedAt = '2026-10-08T13:00:00.000Z') => ({ sidecar: [{ runId, wave: 3, emittedAt, issues: refs.map((ref) => ({ ref })) }] });

test('an outside node names its top epic, read in the same batched lookup, and the other run whose sidecar emitted it (issue #522)', async () => {
  const s = setUp({ siblings: { [`ship-dag/engine/${OTHER}`]: sidecarIn(OTHER, [R(7)]) } });
  const queries = [];
  const gh = fakeGh({ ...TABLE, [R(2)]: { blockers: [R(7)] }, [R(7)]: { parent: R(70) }, [R(70)]: { parent: R(71) } });
  const runGh = async (args) => { queries.push(args); return gh.runGh(args); };
  const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh });
  assert.equal(code, 0, err.join('\n'));
  assert.equal(gh.calls.length, 2, 'no extra query: the parent chain rides the lookup');
  assert.ok(queries.every((a) => a.includes('GraphQL-Features: sub_issues') && a.find((x) => x.startsWith('query=')).includes('parent{')));
  const node = html.slice(html.indexOf('data-ref="o/r#7"'), html.indexOf('data-ref=', html.indexOf('data-ref="o/r#7"') + 1));
  assert.match(node, /<div class="wn">Title 71 <a href="https:\/\/github.com\/o\/r\/issues\/71">r#71<\/a> · run sd-20261001-090000<\/div>/);
});

for (const [name, siblings, own] of [
  ['no run emitted it', {}, []],
  ['only this run\'s own sidecar names it', {}, [R(7)]],
]) {
  test(`an outside node with no parent and no other run reads "no epic · not scheduled": ${name} (issue #522)`, async () => {
    const s = setUp({ siblings });
    if (own.length) appendFileSync(join(s.dir, 'ship-dag-wave.jsonl'), `${JSON.stringify(sidecarIn(RUN, own).sidecar[0])}\n`);
    const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh: fakeGh({ ...TABLE, [R(2)]: { blockers: [R(7)] }, [R(7)]: {} }).runGh });
    assert.equal(code, 0, err.join('\n'));
    assert.match(html, /<div class="wn">no epic · not scheduled<\/div>/);
  });
}

test('a shipped outside ticket and a milestone\'s outside ticket carry the owner label too (issue #522)', async () => {
  const s = setUp({ siblings: { [`ship-dag/engine/${OTHER}`]: sidecarIn(OTHER, [R(8)]) } });
  const gh = fakeGh({ ...TABLE, [R(2)]: { blockers: [R(7), R(8)], labels: ['hitl-gate'] }, [R(7)]: { parent: R(70) }, [R(70)]: {}, [R(8)]: { state: 'CLOSED', closedAt: DURING_RUN, parent: R(80) } });
  const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh: gh.runGh });
  assert.equal(code, 0, err.join('\n'));
  assert.match(shippedRows(html), /Title 8 <span class="owner">outside this run · Title 80 <a href="https:\/\/github.com\/o\/r\/issues\/80">r#80<\/a> · run sd-20261001-090000<\/span>/);
  assert.match(html, /1 outside it \(<a href="https:\/\/github.com\/o\/r\/issues\/7">r#7<\/a> — Title 70 <a href="https:\/\/github.com\/o\/r\/issues\/70">r#70<\/a> · not scheduled\)/);
});

for (const [name, issueSet, want] of [
  ['a label run drops a member closed before startedAt', { repo: 'o/r', label: 'wave' }, '1/3'],
  ['an epic run keeps it', { epic: R(50) }, '2/4'],
]) {
  test(`startedAt filter: ${name}`, async () => {
    const s = setUp({ files: { 'board.json': { ...BOARD, issueSet }, 'dag.json': { ...SPEC, members: [R(1), R(2), R(9), R(5)] } } });
    const table = { ...TABLE, [R(5)]: { state: 'CLOSED', closedAt: '2026-10-07T09:00:00.000Z' }, [R(50)]: {} };
    const { code, html } = await run(['render', '--run-id', RUN], { ...s, runGh: fakeGh(table).runGh });
    assert.equal(code, 0);
    assert.match(html, new RegExp(`<b>${want}</b><span>shipped</span>`));
  });
}

for (const [name, files, want] of [
  ['no dag.json and no --spec', { 'dag.json': undefined }, /dag\.json.*--spec/],
  ['an emit-config-shaped spec', { 'dag.json': { name: 'ship-dag-x', issues: [{ number: 1 }] } }, /nodes/],
  ['no board.json', { 'board.json': undefined }, /board\.json.*init/],
]) {
  test(`render exits 1 and writes nothing: ${name}`, async () => {
    const s = setUp({ files });
    const { code, err, html } = await run(['render', '--run-id', RUN], s);
    assert.equal(code, 1);
    assert.match(err.join('\n'), want);
    assert.equal(html, null);
  });
}

test('--spec reads the graph from elsewhere', async () => {
  const s = setUp({ files: { 'dag.json': undefined } });
  const spec = join(s.base, 'spec-live.json');
  writeFileSync(spec, JSON.stringify(SPEC));
  const { code } = await run(['render', '--run-id', RUN, '--spec', spec], { ...s, runGh: fakeGh(TABLE).runGh });
  assert.equal(code, 0);
});

test('a failure leaves the old board.html byte-identical and no temp file behind', async () => {
  const s = setUp({ files: { 'board.html': 'old page' } });
  const runGh = async () => { throw new Error('gh exploded'); };
  const { code, err } = await run(['render', '--run-id', RUN], { ...s, runGh });
  assert.equal(code, 1);
  assert.match(err.join('\n'), /gh exploded/);
  assert.equal(readFileSync(join(s.dir, 'board.html'), 'utf8'), 'old page');
  assert.deepEqual(readdirSync(s.dir).filter((f) => f.includes('.tmp')), []);
});

test('a rename that fails leaves the target untouched and no temp file behind', async () => {
  const s = setUp();
  const out = join(s.base, 'taken');
  mkdirSync(out);
  writeFileSync(join(out, 'keep'), 'old page');
  const { code } = await run(['render', '--run-id', RUN, '--out', out], { ...s, runGh: fakeGh(TABLE).runGh });
  assert.equal(code, 1);
  assert.equal(readFileSync(join(out, 'keep'), 'utf8'), 'old page');
  assert.deepEqual(readdirSync(out), ['keep']);
  assert.deepEqual(readdirSync(s.base).filter((f) => f.includes('.tmp')), []);
});

for (const [name, missing, want, row = { missing: true }] of [
  ['one issue', [R(2)], `${R(2)}: GitHub has no such issue`],
  ['two issues, named together', [R(1), R(2)], `${R(1)}, ${R(2)}: GitHub has no such issue`],
  ['a deleted issue (REST 410)', [R(2)], `${R(2)}: GitHub has no such issue`, { missing: 410 }],
  ['a pull request, which REST reads as an issue', [R(2)], `${R(2)}: GitHub has no such issue`, { pull: true }],
  ['an issue the token cannot read (REST 403), named with the others', [R(1), R(2)], `${R(1)}, ${R(2)}: GitHub has no such issue`, { missing: 403 }],
]) {
  test(`render names a ref GitHub answers NOT_FOUND for, not gh's message: ${name}`, async () => {
    const s = setUp();
    const table = { ...TABLE, ...Object.fromEntries(missing.map((ref) => [ref, row])) };
    const gh = fakeGh(table);
    const { code, err, html } = await run(['render', '--run-id', RUN], { ...s, runGh: gh.runGh });
    assert.equal(code, 1);
    assert.ok(err.includes(`[board] ${want}`), err.join('\n'));
    assert.doesNotMatch(err.join('\n'), /Could not resolve|Not Found|deleted|not accessible/);
    assert.deepEqual(gh.rest.sort(), missing, 'each missing ref is asked of REST once');
    assert.equal(html, null);
  });
}

// A transferred issue: GraphQL's repository(owner,name){issue} does not follow the move, REST does. The board keeps
// the ref the run knows it by and links it to the issue's new home.
for (const [name, files, table, retro, check] of [
  ['a retro-filed ref', {}, { [R(3)]: { moved: 'x/y#5' }, 'x/y#5': {} }, [R(3)], (html) => {
    assert.ok(html.includes('href="https://github.com/x/y/issues/5"'), 'links the new home');
    assert.ok(html.includes('o/r#3'), 'under the ref the run knows');
  }],
  ['a spec member another ticket names as its blocker by the new ref', { 'dag.json': { nodes: [{ ref: R(1) }, { ref: R(2) }], edges: [], done: [] } },
    { [R(1)]: { moved: 'x/y#5' }, 'x/y#5': {}, [R(2)]: { blockers: ['x/y#5'] } }, [], (html, gh) => {
      assert.equal(gh.calls.flat().filter((r) => r === 'x/y#5').length, 1, 'the new ref is the moved ticket, not an outside blocker to look up again');
      assert.doesNotMatch(html, /Can't be ordered/);
    }],
]) {
  test(`render shows a transferred issue under its old ref and renders the rest: ${name}`, async () => {
    const s = setUp({ files });
    if (retro.length) appendRecord({ kind: 'retro', runId: RUN, wave: 1, mergedPrs: [], filed: retro }, { path: s.env.SHIP_DAG_TELEMETRY });
    const gh = fakeGh({ ...TABLE, ...table });
    const { code, err, html } = await run(['render', '--run-id', RUN], { ...s, runGh: gh.runGh });
    assert.equal(code, 0, err.join('\n'));
    const [from, { moved }] = Object.entries(table).find(([, row]) => row.moved);
    assert.ok(err.includes(`[board] ${from} was transferred to ${moved}; shown under ${from}`), err.join('\n'));
    assert.deepEqual(gh.rest, [from]);
    check(html, gh);
  });
}

test('a transferred issue the spec names by its new ref and the waves by its old is one ticket, and spec edges naming the new ref attach to it', async () => {
  const s = setUp({ files: { 'dag.json': { nodes: [{ ref: 'x/y#5' }, { ref: R(2) }], edges: [{ blocked: R(2), blockedBy: 'x/y#5' }], done: [] } } });
  const { code, err, html } = await run(['render', '--run-id', RUN], { ...s, runGh: fakeGh({ ...TABLE, [R(1)]: { moved: 'x/y#5' }, 'x/y#5': {} }).runGh });
  assert.equal(code, 0, err.join('\n'));
  assert.ok(err.some((m) => m.endsWith('(2 tickets)')), err.join('\n'));
  assert.doesNotMatch(html, />y#5</, 'not listed under its new ref too');
  assert.doesNotMatch(html, /Can't be ordered/, 'r#2 waits on a ticket the board shows');
});

test('two transferred issues keep their own state when one new home is itself read through a second hop', async () => {
  const s = setUp();
  const table = { ...TABLE, [R(1)]: { moved: 'x/y#5' }, 'x/y#5': { moved: 'z/w#6' }, 'z/w#6': {}, [R(2)]: { moved: 'x/y#7' }, 'x/y#7': { state: 'CLOSED' } };
  const { code, err, html } = await run(['render', '--run-id', RUN], { ...s, runGh: fakeGh(table).runGh });
  assert.equal(code, 0, err.join('\n'));
  assert.match(html, /href="https:\/\/github\.com\/z\/w\/issues\/6">[^<]*r#1</);
  assert.match(html, /href="https:\/\/github\.com\/x\/y\/issues\/7">[^<]*r#2</);
});

test('the page names the command it was built with: the script\'s absolute path and the flags given, or the run read from the environment', async () => {
  const s = setUp();
  const spec = join(s.base, 'spec live.json');
  writeFileSync(spec, JSON.stringify(SPEC));
  const out = join(s.base, 'page.html');
  const script = resolve(import.meta.dirname, 'board.mjs');
  assert.equal((await run(['render', '--run-id', RUN, '--spec', spec, '--out', out], { ...s, runGh: fakeGh(TABLE).runGh })).code, 0);
  assert.ok(readFileSync(out, 'utf8').includes(`node ${script} render --run-id ${RUN} --spec &#39;${spec}&#39; --out ${out}<`));
  const { code, html } = await run(['render'], { ...s, env: { ...s.env, SHIP_DAG_RUN_ID: RUN }, runGh: fakeGh(TABLE).runGh });
  assert.equal(code, 0);
  assert.ok(html.includes(`node ${script} render --run-id ${RUN}<`));
});

// The board's files live in the family's base dir, however the run is named.
for (const [name, argv] of [
  ['--state-dir naming a -b sibling', (s) => ['--state-dir', s.dirs[`ship-dag/engine/${RUN}-b`]]],
  ['--run-id spelled ship-dag-<run>', () => ['--run-id', `ship-dag-${RUN}`]],
  ['--run-id spelled in upper case', () => ['--run-id', RUN.toUpperCase()]],
]) {
  test(`render: ${name} reads dag.json from the base dir`, async () => {
    const s = setUp({ siblings: { [`ship-dag/engine/${RUN}-b`]: { configs: { 'config.json': engineConfig([R(1)], { configDir: `/x/${RUN}-b/state` }) } } } });
    const { code, err, html } = await run(['render', ...argv(s)], { ...s, runGh: fakeGh(TABLE).runGh });
    assert.equal(code, 0, err.join('\n'));
    assert.match(html, /Invented board/);
  });
}

test('an unknown run id exits 1 with a "no run" line and writes no file', async () => {
  const s = setUp();
  const { code, err } = await run(['render', '--run-id', 'sd-nobody'], s);
  assert.equal(code, 1);
  assert.match(err.join('\n'), /\[board\] no run sd-nobody under /);
  assert.equal(existsSync(join(s.base, 'ship-dag/engine/sd-nobody')), false);
  assert.equal(existsSync(join(s.dir, 'board.html')), false);
});

test('render reads $SHIP_DAG_RUN_ID when no run is named', async () => {
  const s = setUp();
  const { code } = await run(['render'], { ...s, env: { ...s.env, SHIP_DAG_RUN_ID: RUN }, runGh: fakeGh(TABLE).runGh });
  assert.equal(code, 0);
});

test('a failed ticket with an open PR and no metadata.prNumber, whose latest round blocks, renders Fixing, not Stalled', async () => {
  const finding = { category: 'correctness', verdict: 'CONFIRMED', blocking: true, file: 'a.ts', line: 1, summary: 's', failure_scenario: 'f' };
  const s = setUp({
    files: { [`state/status/issue-${artifactStem(R(1))}.status`]: 'failed' },
    reviews: [{ ref: R(1), findings: [finding], at: '2026-10-08T19:30:00.000Z' }],
  });
  const table = { ...TABLE, [R(1)]: { prs: [{ number: 99, state: 'OPEN' }] } };
  const { code, html } = await run(['render', '--run-id', RUN], { ...s, runGh: fakeGh(table).runGh });
  assert.equal(code, 0);
  assert.match(html, /<span class="chip c-flight">Fixing<\/span>/);
  assert.ok(!html.includes('Stalled'));
});

/** The R(n) node of the road ahead: from its `data-ref` to the next node. */
const nodeOf = (html, ref) => html.slice(html.indexOf(`data-ref="${ref}"`)).split('class="node')[0];

// Wave 2 runs R(1) here and R(2) on host `mini`, whose host-run copies its state/ into the letter dir `-w2z`.
const READ_AT = '2026-10-08T20:25:00.000Z';
for (const [name, letter, want] of [
  ['a remote row the host has started renders as Building, naming its host and when it was read',
    { mirror: { host: 'mini', readAt: READ_AT }, status: 'running' }, { chip: />Building</, host: /on mini · read Oct 8, 1:25 PM PDT/ }],
  ['a remote row the host has not started stays queued, naming its host',
    { mirror: { host: 'mini', readAt: READ_AT } }, { chip: /c-ready">Ready</, host: /on mini · read Oct 8, 1:25 PM PDT/ }],
  ['a remote row before the first copy stays queued, naming its host',
    {}, { chip: /c-ready">Ready</, host: /on mini · not read yet/ }],
  ['a remote row collected with no mirror record still takes its stage from the collected status',
    { status: 'failed' }, { chip: />Stalled</, host: /on mini · read time unknown/ }],
  ['a remote row on an unreachable host stays queued with the note, whatever its last copy said',
    { mirror: { host: 'mini', readAt: READ_AT, unreachableAt: '2026-10-08T20:26:00.000Z' }, status: 'running' }, { chip: /c-ready">Ready</, host: /on mini · host unreachable; stage unknown \(last read Oct 8, 1:25 PM PDT\)/ }],
]) {
  test(name, async () => {
    const wave = `ship-dag/engine/${RUN}-w2`;
    const s = setUp({
      files: { 'dag.json': { ...SPEC, edges: [] } },
      siblings: {
        [wave]: { configs: {
          'hosts/config.local.json': stamped(T1, engineConfig([R(1)], { configDir: `/x/${RUN}-w2/state` })),
          'hosts/config.mini.json': stamped(T1, engineConfig([R(2)], { configDir: `/h/${RUN}-w2/state` })),
        } },
        [`${wave}z`]: { files: {
          ...(letter.mirror && { 'host-mirror.json': letter.mirror }),
          ...(letter.status && { [`state/status/issue-${artifactStem(R(2))}.status`]: letter.status }),
        } },
      },
    });
    const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh: fakeGh(TABLE).runGh });
    assert.equal(code, 0, err.join('\n'));
    const node = nodeOf(html, R(2));
    assert.match(node, want.chip);
    assert.match(node, want.host);
    assert.doesNotMatch(nodeOf(html, R(1)), /on mini/, 'a local row names no host');
  });
}

test('a retro-filed ref and an extraRefs ref join the board', async () => {
  const s = setUp({ files: { 'board-notes.json': { extraRefs: [R(4)] } } });
  appendRecord({ kind: 'retro', runId: RUN, wave: 1, mergedPrs: [], filed: [R(3)] }, { path: s.env.SHIP_DAG_TELEMETRY });
  const { code, html } = await run(['render', '--run-id', RUN], { ...s, runGh: fakeGh({ ...TABLE, [R(3)]: {}, [R(4)]: {} }).runGh });
  assert.equal(code, 0);
  assert.ok(html.includes('o/r#3') && html.includes('o/r#4'));
});

test('init stores the parsed blockOn and stamps startedAt; a second init says board.json exists and leaves the first alone', async () => {
  const s = setUp({ files: { 'board.json': undefined } });
  const argv = ['init', '--run-id', RUN, '--title', 'T', '--block-on', ' Correctness ', '--epic', R(50)];
  assert.equal((await run(argv, s)).code, 0);
  const board = JSON.parse(readFileSync(join(s.dir, 'board.json'), 'utf8'));
  assert.deepEqual(board, { runId: RUN, title: 'T', issueSet: { epic: R(50) }, blockOn: ['correctness'], startedAt: NOW.toISOString() });
  const again = await run([...argv, '--title', 'Other'], s);
  assert.equal(again.code, 1);
  assert.deepEqual(again.err, [`[board] board.json already exists at ${join(s.dir, 'board.json')}`]);
  assert.equal(JSON.parse(readFileSync(join(s.dir, 'board.json'), 'utf8')).title, 'T');
});

test('init --predecessors stores the refs, trimmed', async () => {
  const s = setUp({ files: { 'board.json': undefined } });
  assert.equal((await run(['init', '--run-id', RUN, '--predecessors', `${R(50)}, ${R(51)}`], s)).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(s.dir, 'board.json'), 'utf8')).predecessors, [R(50), R(51)]);
});

test('init for a new run creates its dir', async () => {
  const s = setUp();
  const fresh = join(s.base, 'ship-dag/engine/sd-fresh');
  assert.equal((await run(['init', '--run-id', 'sd-fresh'], { ...s, dir: fresh })).code, 0);
  assert.ok(existsSync(join(fresh, 'board.json')));
});

for (const [name, argv, want] of [
  ['an unknown --block-on category', ['init', '--run-id', 'sd-other', '--block-on', 'nonsense'], /nonsense/],
  ['a --predecessors entry that is not a ref', ['init', '--run-id', 'sd-other', '--predecessors', `${R(50)},nope`], /nope/],
  ['an empty --predecessors entry', ['init', '--run-id', 'sd-other', '--predecessors', `${R(50)},`], /not an owner\/repo#N ref: ""/],
  ['--label without --repo', ['init', '--run-id', 'sd-other', '--label', 'wave'], /--label needs --repo/],
  ['a flag with no value', ['render', '--run-id'], /--run-id requires a value/],
  ['a flag followed by another flag', ['render', '--spec', '--run-id', RUN], /--spec requires a value/],
  ['no run named', ['init'], /no run named/],
]) {
  test(`a usage error exits 64 and writes nothing: ${name}`, async () => {
    const s = setUp();
    const { code, err } = await run(argv, s);
    assert.equal(code, 64);
    assert.match(err.join('\n'), want);
    assert.equal(existsSync(join(s.base, 'ship-dag/engine/sd-other')), false);
  });
}

test('an unknown subcommand is a usage error', async () => {
  const { code, err } = await run(['frobnicate'], setUp());
  assert.equal(code, 64);
  assert.match(err.join('\n'), /usage/);
});

// Predecessor epics: the board's own lookups answer from `fakeGh`; a query for sub-issues (the ones with a
// `subIssues(` selection) answers from `kids`, ref of epic → its closed leaves, as the epic's one page.
function withPredecessors(table, kids) {
  const gh = fakeGh(table);
  const asked = [];
  const runGh = async (args) => {
    const query = args.find((a) => a.startsWith('query='));
    if (!query.includes('subIssues(')) { return gh.runGh(args); }
    assert.ok(args.includes('GraphQL-Features: sub_issues'));
    asked.push(query);
    const data = Object.fromEntries([...query.matchAll(/(e\d+):repository\(owner:"([^"]+)",name:"([^"]+)"\)\{issue\(number:(\d+)\)/g)].map(([, key, owner, name, n]) => {
      const nodes = (kids[`${owner}/${name}#${n}`] ?? []).map(({ number, ...rest }) => ({ number, title: `Old ${number}`, url: `https://github.com/o/r/issues/${number}`,
        state: 'CLOSED', stateReason: 'COMPLETED', closedAt: '2026-09-02T19:00:00Z', repository: { nameWithOwner: 'o/r' }, subIssuesSummary: { total: 0 }, ...rest }));
      return [key, { issue: { title: 'First epic', url: `https://github.com/${owner}/${name}/issues/${n}`, subIssues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } }];
    }));
    return JSON.stringify({ data });
  };
  return { runGh, asked };
}

test('render reads board.json\'s predecessors: their closed leaves join the headline and a collapsed section, the run\'s own tickets do not count twice', async () => {
  const s = setUp({ files: { 'board.json': { ...BOARD, predecessors: [R(50)] } } });
  const kids = { [R(50)]: [{ number: 60 }, { number: 61 }, { number: 62, stateReason: 'NOT_PLANNED' }, { number: 63, state: 'OPEN', stateReason: null }, { number: 1 }] };
  const gh = withPredecessors(TABLE, kids);
  const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh: gh.runGh });
  assert.equal(code, 0, err.join('\n'));
  assert.equal(gh.asked.length, 1, 'one extra query');
  assert.match(html, /<b>3\/5<\/b><span>shipped \(2 before this run\)<\/span>/, 'the run\'s 1 of 3, plus 2 earlier; #1 is the run\'s, #62 dropped, #63 open');
  assert.match(html, /<summary>Shipped before this run: <a href="https:\/\/github.com\/o\/r\/issues\/50">r#50<\/a> — First epic \(2, plus 1 closed without shipping\)<\/summary>/);
});

test('render counts a predecessor leaf that blocks a run ticket as shipped before the run: only the run\'s own tickets are left out', async () => {
  const s = setUp({ files: { 'board.json': { ...BOARD, predecessors: [R(50), R(50)] }, 'dag.json': { ...SPEC, edges: [...SPEC.edges, { blocked: R(1), blockedBy: R(60) }] } } });
  const gh = withPredecessors({ ...TABLE, [R(60)]: { state: 'CLOSED', closedAt: '2026-09-02T19:00:00Z' } }, { [R(50)]: [{ number: 60 }, { number: 61 }] });
  const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh: gh.runGh });
  assert.equal(code, 0, err.join('\n'));
  assert.match(html, /<b>3\/5<\/b><span>shipped \(2 before this run\)<\/span>/, '#60 is a closed blocker the board looked up, not one of its tickets');
  assert.equal(html.split('<summary>Shipped before this run').length - 1, 1, 'a predecessor named twice is one section');
});

test('a predecessor leaf that is also a shipped outside blocker counts once (issue #522)', async () => {
  const s = setUp({ files: { 'board.json': { ...BOARD, predecessors: [R(50)] } } });
  const gh = withPredecessors({ ...TABLE, [R(2)]: { blockers: [R(60)] }, [R(60)]: { state: 'CLOSED', closedAt: DURING_RUN } }, { [R(50)]: [{ number: 60, closedAt: DURING_RUN }, { number: 61 }] });
  const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh: gh.runGh });
  assert.equal(code, 0, err.join('\n'));
  assert.match(html, /<b>3\/5<\/b><span>shipped \(1 before this run\)<\/span>/, 'r#9 and r#60 this run, r#61 before it; r#60 is not also a predecessor leaf');
});

test('render with a predecessor GitHub does not have, through GraphQL or REST, exits 1 and names it', async () => {
  const s = setUp({ files: { 'board.json': { ...BOARD, predecessors: [R(50)] } } });
  const runGh = async (args) => (args.find((a) => a.startsWith('query='))?.includes('subIssues(') ? graphqlAnswer({ data: { e0: { issue: null } }, errors: [{ type: 'NOT_FOUND', path: ['e0', 'issue'], message: 'x' }] }) : fakeGh({ ...TABLE, [R(50)]: { missing: true } }).runGh(args));
  const { code, err, html } = await run(['render', '--run-id', RUN], { ...s, runGh });
  assert.equal(code, 1);
  assert.ok(err.includes(`[board] ${R(50)}: GitHub has no such issue`), err.join('\n'));
  assert.equal(html, null);
});

test('render with a predecessors value that is not an array exits 1 and says so', async () => {
  const s = setUp({ files: { 'board.json': { ...BOARD, predecessors: R(50) } } });
  const { code, err } = await run(['render', '--run-id', RUN], { ...s, runGh: fakeGh(TABLE).runGh });
  assert.equal(code, 1);
  assert.match(err.join('\n'), /predecessors must be an array/);
});

test('render with a malformed predecessor ref exits 1 before reading GitHub for it', async () => {
  const s = setUp({ files: { 'board.json': { ...BOARD, predecessors: ['nope'] } } });
  const { code, err } = await run(['render', '--run-id', RUN], { ...s, runGh: fakeGh(TABLE).runGh });
  assert.equal(code, 1);
  assert.match(err.join('\n'), /not an owner\/repo#N ref: "nope"/);
});

test('render asks for createdAt in its batched lookup and draws the burn-up from board.json\'s startedAt', async () => {
  const s = setUp();
  const queries = [];
  const gh = fakeGh({ ...TABLE, [R(2)]: { createdAt: '2026-10-08T15:00:00.000Z' } });
  const runGh = async (args) => { queries.push(args.find((a) => a.startsWith('query='))); return gh.runGh(args); };
  const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh });
  assert.equal(code, 0, err.join('\n'));
  assert.equal(queries.length, 1, 'no extra query for the chart');
  assert.match(queries[0], /createdAt/);
  assert.match(html, /<section class="burn">/);
  assert.match(html, /aria-label="Burn-up: 1 of 3 shipped this run as of Oct 8, 1:30 PM PDT; 2 in scope when the run started, Oct 8, 5:00 AM PDT\."/,
    'r#1 and r#9 from the start, r#9 shipped at 6 AM, r#2 filed at 8 AM');
});

// ---- refresh: fetch the run's graph spec, write spec-board.json, render ----

/** `run`, with the extra deps `refresh` takes (`fetchSpec`, `runGhSync`), and `spec-board.json` read back (null if absent). */
async function refresh(argv, { env, dir, runGh = async () => { throw new Error('no gh expected'); }, ...deps }) {
  const err = [];
  const code = await main(argv, { runGh, env, now: () => NOW, log: (m) => err.push(m), sleep: async () => {}, ...deps });
  const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : null);
  return { code, err, html: read('board.html'), spec: read('spec-board.json') && JSON.parse(read('spec-board.json')) };
}

/** A sync `gh` for plan-waves' fetchSpec over a label's issues; `fail` makes the open listing throw as gh does. */
function fakeFetchGh({ open = [1, 2], closed = [9], fail } = {}) {
  const calls = [];
  const runGhSync = (args) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'list') {
      if (fail) { throw fail(args); }
      return JSON.stringify((args[args.indexOf('--state') + 1] === 'closed' ? closed : open).map((number) => ({ number })));
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      return JSON.stringify({ number: Number(args[2]), title: `Title ${args[2]}`, labels: [], body: Number(args[2]) === 2 ? 'Blocked by #1' : '', state: 'OPEN' });
    }
    if (args[0] === 'api') { return ''; } // no native blocked_by edges
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { runGhSync, calls };
}

const EPIC_BOARD = { ...BOARD, issueSet: { epic: R(50) } };
const EPIC_TABLE = { ...TABLE, [R(50)]: {} };
const WIRE_SPEC = { repo: 'o/r', nodes: [{ ref: R(1) }, { ref: R(2) }], edges: [{ blocked: R(2), blockedBy: R(1) }], done: [R(9)], members: [R(1), R(2), R(9)] };

test('refresh on an epic run fetches the epic with --members, writes spec-board.json, and renders from it', async () => {
  const s = setUp({ files: { 'board.json': EPIC_BOARD, 'dag.json': undefined } });
  const seen = [];
  const fetchSpec = (repo, opts) => { seen.push([repo, opts.epic, opts.label, opts.members]); return WIRE_SPEC; };
  const { code, err, html, spec } = await refresh(['refresh', '--run-id', RUN], { ...s, runGh: fakeGh(EPIC_TABLE).runGh, fetchSpec });
  assert.equal(code, 0, err.join('\n'));
  assert.deepEqual(seen, [['o/r', '50', undefined, true]]);
  assert.deepEqual(spec, WIRE_SPEC);
  assert.match(html, /<b>1\/3<\/b><span>shipped<\/span>/);
  assert.ok(html.includes(`board.mjs refresh --run-id ${RUN}`), 'the page names the command that rebuilt it');
  assert.deepEqual(readdirSync(s.dir).filter((f) => f.includes('.tmp')), []);
});

test('refresh on a label run lists the label (open and closed) through plan-waves fetchSpec with the injected sync gh', async () => {
  const s = setUp({ files: { 'board.json': { ...BOARD, issueSet: { repo: 'o/r', label: 'wave' } }, 'dag.json': undefined } });
  const gh = fakeFetchGh();
  const { code, err, html, spec } = await refresh(['refresh', '--run-id', RUN], { ...s, runGh: fakeGh(TABLE).runGh, runGhSync: gh.runGhSync });
  assert.equal(code, 0, err.join('\n'));
  assert.deepEqual(spec.members, [R(1), R(2), R(9)]);
  assert.deepEqual(spec.edges, [{ blocked: R(2), blockedBy: R(1) }]);
  assert.deepEqual(gh.calls.filter((a) => a[1] === 'list').map((a) => a[a.indexOf('--label') + 1] + ':' + a[a.indexOf('--state') + 1]), ['wave:open', 'wave:closed']);
  assert.match(html, /<b>1\/3<\/b><span>shipped<\/span>/);
});

test('refresh overwrites a stale spec-board.json and ignores dag.json', async () => {
  const s = setUp({ files: { 'board.json': EPIC_BOARD, 'spec-board.json': { nodes: [{ ref: R(77) }], edges: [] } } });
  const { code, spec, html } = await refresh(['refresh', '--run-id', RUN], { ...s, runGh: fakeGh(EPIC_TABLE).runGh, fetchSpec: () => WIRE_SPEC });
  assert.equal(code, 0);
  assert.deepEqual(spec, WIRE_SPEC);
  assert.ok(!html.includes('o/r#77'));
});

test('refresh --state-dir finds the run too, and --out redirects the page but not spec-board.json', async () => {
  const s = setUp({ files: { 'board.json': EPIC_BOARD, 'dag.json': undefined } });
  const out = join(s.base, 'elsewhere.html');
  const { code, spec } = await refresh(['refresh', '--state-dir', s.dir, '--out', out], { ...s, runGh: fakeGh(EPIC_TABLE).runGh, fetchSpec: () => WIRE_SPEC });
  assert.equal(code, 0);
  assert.deepEqual(spec, WIRE_SPEC);
  assert.ok(existsSync(out));
  assert.equal(existsSync(join(s.dir, 'board.html')), false);
});

for (const [name, deps, want] of [
  ['an injected fetch that throws', { fetchSpec: () => { throw new Error('boom from fetch'); } }, /boom from fetch/],
  ['a gh failure listing the label', { runGhSync: fakeFetchGh({ fail: (args) => ghExecError(args, { stderr: 'gh: Bad credentials (HTTP 401)\n' }) }).runGhSync }, /Bad credentials/],
]) {
  test(`refresh exits 1 and leaves board.html and spec-board.json untouched: ${name}`, async () => {
    const s = setUp({ files: { 'board.json': { ...BOARD, issueSet: deps.fetchSpec ? { epic: R(50) } : { repo: 'o/r', label: 'wave' } }, 'dag.json': undefined, 'board.html': '<old board>', 'spec-board.json': { nodes: [], keep: true } } });
    const { code, err, html, spec } = await refresh(['refresh', '--run-id', RUN], { ...s, runGh: fakeGh(EPIC_TABLE).runGh, ...deps });
    assert.equal(code, 1);
    assert.match(err.join('\n'), want);
    assert.equal(html, '<old board>');
    assert.deepEqual(spec, { nodes: [], keep: true });
  });
}

test('refresh exits 1 and keeps the old board.html when the fetch works but the render fails', async () => {
  const s = setUp({ files: { 'board.json': EPIC_BOARD, 'dag.json': undefined, 'board.html': '<old board>' } });
  const down = async () => { throw new Error('GitHub is down'); };
  const { code, err, html } = await refresh(['refresh', '--run-id', RUN], { ...s, runGh: down, fetchSpec: () => WIRE_SPEC });
  assert.equal(code, 1);
  assert.match(err.join('\n'), /GitHub is down/);
  assert.equal(html, '<old board>');
});

test('refresh with no board.json exits 1 with the init hint, before any fetch', async () => {
  const s = setUp({ files: { 'board.json': undefined } });
  let fetched = false;
  const { code, err, spec } = await refresh(['refresh', '--run-id', RUN], { ...s, fetchSpec: () => { fetched = true; return WIRE_SPEC; } });
  assert.equal(code, 1);
  assert.match(err.join('\n'), /board\.json.*init/);
  assert.equal(fetched, false);
  assert.equal(spec, null);
});

test('refresh on a run whose board.json names no epic or label warns, does not fetch, and renders from dag.json', async () => {
  const s = setUp();
  let fetched = false;
  const { code, err, html } = await refresh(['refresh', '--run-id', RUN], { ...s, runGh: fakeGh(TABLE).runGh, fetchSpec: () => { fetched = true; return WIRE_SPEC; } });
  assert.equal(code, 0, err.join('\n'));
  assert.equal(fetched, false);
  assert.ok(err.some((m) => /neither an epic nor a label/.test(m)), err.join('\n'));
  assert.match(html, /<b>1\/3<\/b><span>shipped<\/span>/);
});

for (const [name, argv, want] of [
  ['no run named', ['refresh'], /no run named/],
  ['a flag with no value', ['refresh', '--run-id'], /--run-id requires a value/],
  ['--spec, which refresh writes itself', ['refresh', '--run-id', RUN, '--spec', '/x.json'], /--spec/],
]) {
  test(`refresh: a usage error exits 64 and fetches and writes nothing: ${name}`, async () => {
    const s = setUp({ files: { 'board.json': EPIC_BOARD, 'dag.json': undefined } });
    let fetched = false;
    const { code, err, html, spec } = await refresh(argv, { ...s, fetchSpec: () => { fetched = true; return WIRE_SPEC; } });
    assert.equal(code, 64);
    assert.match(err.join('\n'), want);
    assert.equal(fetched, false);
    assert.deepEqual([html, spec], [null, null]);
  });
}

test('refresh takes $SHIP_DAG_RUN_ID like render, and the page names the run in its rebuild command', async () => {
  const s = setUp({ files: { 'board.json': EPIC_BOARD, 'dag.json': undefined } });
  const { code, html } = await refresh(['refresh'], { ...s, env: { ...s.env, SHIP_DAG_RUN_ID: RUN }, runGh: fakeGh(EPIC_TABLE).runGh, fetchSpec: () => WIRE_SPEC });
  assert.equal(code, 0);
  assert.ok(html.includes(`board.mjs refresh --run-id ${RUN}`));
});

test('the usage line for a bad subcommand lists refresh', async () => {
  const s = setUp();
  const { code, err } = await run(['bogus'], s);
  assert.equal(code, 64);
  assert.match(err.join('\n'), /init\|render\|refresh/);
});

test("SKILL.md tells the orchestrator to run `board.mjs refresh --run-id` after each status-changing event", () => {
  const rule = docLine('**Status board.**');
  assert.match(rule, /board\.mjs" refresh --run-id "\$RUN_ID"/);
  for (const event of ['engine report', 'review round', 'fix pass', 'merge', 'ingest', 'sub-epic', 'retro', 'ops ticket', 'out-of-band merge']) {
    assert.ok(rule.toLowerCase().includes(event), `names the event: ${event}`);
  }
});

test('refresh on an explicit-set run (issueSet {}) with no dag.json exits 1, naming --spec and init --epic/--label, before any fetch', async () => {
  const s = setUp({ files: { 'dag.json': undefined, 'board.html': '<old board>' } });
  let fetched = false;
  const { code, err, html, spec } = await refresh(['refresh', '--run-id', RUN], { ...s, runGh: fakeGh(TABLE).runGh, fetchSpec: () => { fetched = true; return WIRE_SPEC; } });
  assert.equal(code, 1);
  assert.match(err.join('\n'), /dag\.json.*--spec.*render.*init.*--epic.*--label/s);
  assert.equal(fetched, false);
  assert.equal(html, '<old board>');
  assert.equal(spec, null);
});

// ---- the documented cost, the render/CO_HOME claim, and the usage line stay consistent across the header, README and SKILL.md ----

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const COST = 'about L+2 GraphQL queries and L REST calls for L open leaves, plus ceil(T/40) GraphQL queries to render T tickets';

for (const file of ['./board.mjs', '../README.md', '../SKILL.md']) {
  test(`${file} states the one refresh cost figure and no longer claims render works without claude-orchestrator`, () => {
    const text = read(file).replace(/\s*\n\/\/\s*|\s+/g, ' ');
    assert.ok(text.includes(COST), `${file} states: ${COST}`);
    assert.doesNotMatch(text, /never needs the topo core|render never needs|render needs no CO_HOME|without claude-orchestrator/i);
  });
}

test('board.mjs imports plan-waves statically: no lazy import indirection', () => {
  assert.doesNotMatch(read('./board.mjs'), /await import\(/);
  assert.match(read('./board.mjs'), /^import \{ fetchSpec as \w+ \} from '\.\/plan-waves\.mjs';$/m);
});

test('the usage header shows refresh taking $SHIP_DAG_RUN_ID, like render', () => {
  assert.match(read('./board.mjs'), /board\.mjs refresh \[--state-dir <dir> \| --run-id <id>\]/);
});

test('SKILL.md tells a resumed run to run init when board.json is absent, and documents explicit sets', () => {
  const rule = docLine('**Status board.**');
  assert.doesNotMatch(rule, /already has its `board\.json`/);
  assert.match(rule, /run it first if `\$STATE\/board\.json` is absent/);
  assert.match(rule, /explicit set/);
  assert.match(rule, /render --spec/);
});

// A hitl-gate label on a run ticket makes it a milestone, read from the batched lookup that already runs (issue #518).
test('a hitl-gate ticket is a milestone, its label read in the same batched query; a notes milestone outside the run warns (issue #518)', async () => {
  const s = setUp({ files: { 'board-notes.json': { milestones: { [R(1)]: 'Trace tool', [R(42)]: 'Nowhere' } } } });
  const gh = fakeGh({ ...TABLE, [R(2)]: { labels: ['enhancement', 'hitl-gate'], blockers: [] } });
  const queries = [];
  const runGh = async (args) => { queries.push(args.find((a) => a.startsWith('query=')) ?? ''); return gh.runGh(args); };
  const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh });
  assert.equal(code, 0, err.join('\n'));
  assert.deepEqual(gh.calls.map((c) => c.sort()), [[R(1), R(2), R(9)]], 'no extra query');
  assert.ok(queries.every((q) => q.includes('labels(first:100){nodes{name}}')), 'the lookup asks for labels, up to 100 so a crowded ticket keeps its hitl-gate');
  const section = html.slice(html.indexOf('<h2>Milestones'), html.indexOf('<h2>In flight'));
  assert.match(section, /<td>Trace tool<span class="chip ms-next">Next<\/span>/);
  assert.match(section, /<td>Trace tool[\s\S]*?<td>Next up: nothing open before it<\/td>/);
  assert.match(section, /<td>Title 2<\/td>[\s\S]*?<td>1 open ticket before it<\/td>/);
  assert.match(html, /data-ref="o\/r#2"(?:(?!data-ref)[\s\S])*?<div class="ms-badge">Milestone: Title 2<\/div>/);
  assert.ok(err.includes('[board] board-notes milestones names o/r#42, which is not a ticket of this run'), err.join('\n'));
});

// A `milestones` that is not an object is ignored with one warning, not one per character or index (issue #518).
for (const [name, value] of [['a string', 'Trace tool'], ['an array', [R(1), R(2)]], ['a number', 7], ['null', null]]) {
  test(`board-notes milestones as ${name} is ignored with one warning (issue #518)`, async () => {
    const s = setUp({ files: { 'board-notes.json': { milestones: value } } });
    const { code, html, err } = await run(['render', '--run-id', RUN], { ...s, runGh: fakeGh(TABLE).runGh });
    assert.equal(code, 0, err.join('\n'));
    assert.ok(!html.includes('<h2>Milestones'));
    const warns = err.filter((l) => l.includes('milestones'));
    assert.equal(warns.length, value === null ? 0 : 1, warns.join('\n'));
    if (value !== null) assert.ok(warns[0].includes('board-notes milestones must be an object of ref to name'), warns[0]);
  });
}
