// Tests for the board CLI. Runs are real dirs built through the shared engine fixture; `gh` is a fake that answers
// the CLI's batched GraphQL queries from a table of issues and records every query it is asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { main } from './board.mjs';
import { graphqlAnswer } from './lib/gh-fixture.mjs';
import { RUN, T0, engineConfig, engineFixture, stamped } from './lib/engine-fixture.mjs';
import { parseRef } from './lib/ref.mjs';
import { artifactStem } from './lib/failure.mjs';
import { appendRecord } from './telemetry.mjs';

const R = (n) => `o/r#${n}`;
const NOW = new Date('2026-10-08T20:30:00.000Z');
const STARTED = '2026-10-08T12:00:00.000Z';
const BOARD = { runId: RUN, title: 'Invented board', issueSet: {}, blockOn: ['correctness'], startedAt: STARTED };
const SPEC = { nodes: [{ ref: R(1) }, { ref: R(2) }], edges: [{ blocked: R(2), blockedBy: R(1) }], done: [R(9)] };

const fixtures = [];
test.after(() => fixtures.forEach((fx) => fx.cleanup()));

/** A base dir holding the run's family: `RUN` (a config for refs 1 and 2, `files` beside it, one left undefined is left out) and any `siblings`. */
function setUp({ files = {}, siblings = {}, reviews = [] } = {}) {
  const fx = engineFixture({
    [`ship-dag/engine/${RUN}`]: {
      configs: { 'config.json': stamped(T0, engineConfig([R(1), R(2)], { configDir: `/x/${RUN}/state` })) },
      files: Object.fromEntries(Object.entries({ 'board.json': BOARD, 'dag.json': SPEC, ...files }).filter(([, body]) => body !== undefined)),
      reviews,
    },
    ...siblings,
  });
  fixtures.push(fx);
  const dir = fx.dirs[`ship-dag/engine/${RUN}`];
  return { ...fx, dir, env: { XDG_STATE_HOME: fx.base, HOME: '/nope', SHIP_DAG_TELEMETRY: join(fx.base, 'runs.jsonl') } };
}

const WIRE = /repository\(owner:"([^"]+)",name:"([^"]+)"\)\{issue\(number:(\d+)\)/g;

/**
 * A fake `gh api graphql` over `table` (ref → `{state, stateReason, closedAt, prs, blockers}`, a blocker being a ref,
 * or `{missing: true}` for an issue GitHub does not have): answers each aliased lookup as gh 2.102.0 does
 * (`graphqlAnswer`: a NOT_FOUND alias makes gh exit 1 with the body on stdout), throws on a ref the table lacks,
 * and records each query's refs in `calls`.
 */
function fakeGh(table) {
  const calls = [];
  const stateOf = (ref) => table[ref]?.state ?? 'OPEN';
  const runGh = async (args) => {
    assert.deepEqual(args.slice(0, 2), ['api', 'graphql']);
    const refs = [...args.find((a) => a.startsWith('query=')).matchAll(WIRE)].map(([, owner, name, n]) => `${owner}/${name}#${n}`);
    calls.push(refs);
    const errors = [];
    const data = Object.fromEntries(refs.map((ref, i) => {
      const row = table[ref];
      if (!row) throw new Error(`unexpected lookup of ${ref}`);
      const { number, repo } = parseRef(ref);
      if (row.missing) {
        errors.push({ type: 'NOT_FOUND', path: [`r${i}`, 'issue'], message: `Could not resolve to an Issue with the number of ${number}.` });
        return [`r${i}`, { issue: null }];
      }
      return [`r${i}`, { issue: {
        number, title: `Title ${number}`, url: `https://github.com/${repo}/issues/${number}`, state: row.state ?? 'OPEN',
        stateReason: row.stateReason ?? null, closedAt: row.closedAt ?? null, ...(row.createdAt && { createdAt: row.createdAt }),
        closedByPullRequestsReferences: { nodes: (row.prs ?? []).map((p) => ({ url: `https://github.com/${repo}/pull/${p.number}`, ...p })) },
        blockedBy: { nodes: (row.blockers ?? []).map((b) => ({ number: parseRef(b).number, state: stateOf(b), repository: { nameWithOwner: parseRef(b).repo } })) },
      } }];
    }));
    return graphqlAnswer(errors.length ? { data, errors } : { data });
  };
  return { runGh, calls };
}

/** Run the CLI; returns `{code, err, html}` (`html` is `board.html` in `dir`, or null). */
async function run(argv, { env, dir, runGh = async () => { throw new Error('no gh expected'); } }) {
  const err = [];
  const code = await main(argv, { runGh, env, now: () => NOW, log: (m) => err.push(m), sleep: async () => {} });
  const path = join(dir, 'board.html');
  return { code, err, html: existsSync(path) ? readFileSync(path, 'utf8') : null };
}

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

test('an open blocker outside the set is looked up in a closure round, a closed one is not, and its dependent cannot be ordered', async () => {
  const s = setUp();
  const gh = fakeGh({ ...TABLE, [R(2)]: { blockers: [R(7), R(8)] }, [R(7)]: { blockers: [R(6)] }, [R(6)]: { state: 'CLOSED' }, [R(8)]: { state: 'CLOSED' } });
  const { code, html } = await run(['render', '--run-id', RUN], { ...s, runGh: gh.runGh });
  assert.equal(code, 0);
  assert.deepEqual(gh.calls.map((c) => c.sort()), [[R(1), R(2), R(9)], [R(7)]]);
  assert.match(html, /Can't be ordered/);
});

test('the closure stops after five rounds and says so', async () => {
  const s = setUp({ files: { 'dag.json': { nodes: [{ ref: R(1) }], edges: [], done: [] } } });
  const table = { ...TABLE, [R(1)]: { blockers: [R(10)] } };
  for (let n = 10; n < 20; n += 1) table[R(n)] = { blockers: [R(n + 1)] };
  const { code, err } = await run(['render', '--run-id', RUN], { ...s, runGh: fakeGh(table).runGh });
  assert.equal(code, 0);
  assert.ok(err.some((m) => /closure/.test(m)), err.join('\n'));
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

for (const [name, missing, want] of [
  ['one issue', [R(2)], `${R(2)}: GitHub has no such issue`],
  ['two issues, named together', [R(1), R(2)], `${R(1)}, ${R(2)}: GitHub has no such issue`],
]) {
  test(`render names a ref GitHub answers NOT_FOUND for, not gh's message: ${name}`, async () => {
    const s = setUp();
    const table = { ...TABLE, ...Object.fromEntries(missing.map((ref) => [ref, { missing: true }])) };
    const { code, err, html } = await run(['render', '--run-id', RUN], { ...s, runGh: fakeGh(table).runGh });
    assert.equal(code, 1);
    assert.ok(err.includes(`[board] ${want}`), err.join('\n'));
    assert.doesNotMatch(err.join('\n'), /Could not resolve/);
    assert.equal(html, null);
  });
}

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

test('render with a predecessor GitHub does not have exits 1 and names it', async () => {
  const s = setUp({ files: { 'board.json': { ...BOARD, predecessors: [R(50)] } } });
  const runGh = async (args) => (args.find((a) => a.startsWith('query=')).includes('subIssues(') ? graphqlAnswer({ data: { e0: { issue: null } }, errors: [{ type: 'NOT_FOUND', path: ['e0', 'issue'], message: 'x' }] }) : fakeGh(TABLE).runGh(args));
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
