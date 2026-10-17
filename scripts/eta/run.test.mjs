// Tests for the ETA CLI: locating a run, reading its state dirs, the one batched GraphQL query, and the degraded
// path when gh is unavailable. Fixtures are real dirs under a temp state base; `gh` is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fsIo, main } from './run.mjs';
import { latestRun, runStartFromId, liveQuery } from './state.mjs';

const RUN = 'sd-20261017-080000';
const bases = [];
test.after(() => bases.forEach((b) => rmSync(b, { recursive: true, force: true })));

function put(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}

/**
 * A state base holding one run with two family dirs: o/r#1 merged, o/r#2 and o/r#3 open, o/r#4 blocked. Each of
 * #1-#3 has a latest engine start and a passing review round, 20, 30 and 40 minutes after it.
 */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'eta-run-'));
  bases.push(base);
  const dir = join(base, RUN);
  put(join(dir, 'dag.json'), { repo: 'o/r', nodes: [{ ref: 'o/r#9' }], edges: [], done: [] });
  put(join(dir, 'dag.new.json'), {
    repo: 'o/r', nodes: ['o/r#2', 'o/r#3', 'o/r#4'].map((ref) => ({ ref })), edges: [], done: ['o/r#1'],
    members: ['o/r#1', 'o/r#2', 'o/r#3', 'o/r#4'],
  });
  put(join(dir, 'plan.new.json'), { waves: [['o/r#2', 'o/r#3']], blocked: [{ ref: 'o/r#4', reason: 'external', missing: ['x/y#1'] }], cyclic: [] });
  put(join(dir, 'state/metadata', `issue-${encodeURIComponent('o/r#1')}.json`), { startedAt: '2026-10-17T16:00:00.000Z' });
  put(join(`${dir}-w1b`, 'state/metadata', `issue-${encodeURIComponent('o/r#1')}.json`), { startedAt: '2026-10-17T17:00:00.000Z' });
  put(join(`${dir}-w1b`, 'state/metadata', `issue-${encodeURIComponent('o/r#2')}.json`), { startedAt: '2026-10-17T17:00:00.000Z' });
  put(join(`${dir}-w1b`, 'state/metadata', `issue-${encodeURIComponent('o/r#3')}.json`), { startedAt: '2026-10-17T17:10:00.000Z' });
  for (const [ref, passed] of [['o/r#1', '17:20'], ['o/r#2', '17:30'], ['o/r#3', '17:50']]) {
    const round = join(dir, 'reviews', `${encodeURIComponent(ref)}.json`);
    put(round, { issue: 1, findings: [] });
    const when = new Date(`2026-10-17T${passed}:00Z`);
    utimesSync(round, when, when);
  }
  put(join(`${dir}-w1b`, 'state/reports/r.json'), { startedAt: '2026-10-17T17:00:00.000Z', issues: [{ ref: 'o/r#1', number: 1, status: 'succeeded', prNumber: 11 }] });
  // An older run, and a family dir of the newer one, must not be picked as the newest run.
  mkdirSync(join(base, 'sd-20261001-090000'));
  return { base, dir };
}

const answer = {
  data: {
    r0: {
      i1: { state: 'CLOSED', stateReason: 'COMPLETED', closedAt: '2026-10-17T17:31:00Z', closedByPullRequestsReferences: { nodes: [] } },
      i2: { state: 'OPEN', stateReason: null, closedAt: null, closedByPullRequestsReferences: { nodes: [] } },
      i3: { state: 'OPEN', stateReason: null, closedAt: null, closedByPullRequestsReferences: { nodes: [] } },
      i4: { state: 'OPEN', stateReason: null, closedAt: null, closedByPullRequestsReferences: { nodes: [] } },
      p11: { mergedAt: '2026-10-17T17:30:00Z' },
    },
  },
};

async function run(argv, { gh = async () => JSON.stringify(answer), base, reviews } = {}) {
  const out = [];
  const err = [];
  const calls = [];
  const code = await main(argv, {
    env: { XDG_STATE_HOME: '/nope', HOME: '/nope' },
    now: Date.parse('2026-10-17T18:00:00Z'),
    gh: async (args) => { calls.push(args); return gh(args); },
    ...(reviews ? { reviews } : {}),
    stdout: (s) => out.push(s), stderr: (s) => err.push(s),
  });
  return { code, out: out.join('\n'), err: err.join('\n'), calls, base };
}

test('latestRun picks the newest run by the start its id encodes, skipping wave dirs', async () => {
  const { base } = fixture();
  mkdirSync(join(base, `${RUN}-w9`));
  assert.equal(await latestRun(fsIo, base), RUN);
});

test('latestRun skips a newer dir that holds no fetched DAG (a board dir, a retry, a run that kept its spec elsewhere)', async () => {
  const { base } = fixture();
  mkdirSync(join(base, `${RUN}-board`));
  mkdirSync(join(base, 'sd-20261018-090000'));
  assert.equal(await latestRun(fsIo, base), RUN);
});

test('latestRun is null under an empty or missing base', async () => {
  assert.equal(await latestRun(fsIo, join(tmpdir(), 'eta-no-such-base')), null);
});

for (const [id, want] of [
  ['sd-20261016-213248', new Date(2026, 9, 16, 21, 32, 48).getTime()],
  ['sd-20261016-102344-bs-afk', new Date(2026, 9, 16, 10, 23, 44).getTime()],
  ['ship-dag-20260928-115554', new Date(2026, 8, 28, 11, 55, 54).getTime()],
  ['not-a-run', null],
]) {
  test(`runStartFromId(${id}) reads the id's local time`, () => {
    assert.equal(runStartFromId(id), want);
  });
}

test('liveQuery batches every issue and PR into one query, grouped per repo', () => {
  const { text: q, repos } = liveQuery(['o/r#1', 'o/r#2', 'p/q#7'], [{ repo: 'o/r', number: 11 }]);
  assert.deepEqual(repos, ['o/r', 'p/q']);
  assert.match(q, /r0: repository\(owner: "o", name: "r"\) \{ i1: issue\(number: 1\)/);
  assert.match(q, /i2: issue\(number: 2\)/);
  assert.match(q, /p11: pullRequest\(number: 11\)/);
  assert.match(q, /r1: repository\(owner: "p", name: "q"\) \{ i7: issue\(number: 7\)/);
});

test('main prints the estimate for the newest run, from one gh call, with the report PR as the merge time', async () => {
  const { base } = fixture();
  const got = await run(['--state-base', base, '--json']);
  assert.equal(got.code, 0, got.err);
  assert.equal(got.calls.length, 1);
  const json = JSON.parse(got.out);
  assert.equal(json.runId, RUN);
  assert.deepEqual(json.blocked, ['o/r#4']);
  assert.deepEqual(json.queues.map((q) => [q.repo, q.merged, q.remaining]), [['o/r', 1, 2]]);
  assert.equal(json.depth.samples, 3);
  assert.deepEqual(json.depth.latency, { lo: 25 * 60_000, mid: 30 * 60_000, hi: 35 * 60_000 }, 'from the latest engine start across the family dirs to the review pass');
  assert.equal(json.runStart, Math.min(Date.parse('2026-10-17T16:00:00Z'), new Date(2026, 9, 17, 8).getTime()), 'the run starts at its first engine start or its id, whichever is earlier');
  assert.match(json.etaPacific.mid, /P[DS]T$/);
});

test('main without gh degrades to the fetched DAG and says so', async () => {
  const { base } = fixture();
  const got = await run(['--state-base', base, '--run', RUN], { gh: async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); } });
  assert.equal(got.code, 0, got.err);
  assert.match(got.out, /Note: gh unavailable/);
  assert.match(got.out, /o\/r +0 +2 +15m \/ 15m \/ 15m\*/);
  assert.match(got.err, /gh unavailable/);
});

test('main exits 1 naming the base when there is no run', async () => {
  const base = mkdtempSync(join(tmpdir(), 'eta-empty-'));
  bases.push(base);
  const got = await run(['--state-base', base]);
  assert.equal(got.code, 1);
  assert.match(got.err, /no ship-dag run under/);
});

test('main exits 1 when the run has no fetched DAG', async () => {
  const base = mkdtempSync(join(tmpdir(), 'eta-nodag-'));
  bases.push(base);
  mkdirSync(join(base, RUN));
  const got = await run(['--state-base', base, '--run', RUN]);
  assert.equal(got.code, 1);
  assert.match(got.err, /no dag\.json/);
});

test('main reads the newer of dag.json and dag.new.json', async () => {
  const { base, dir } = fixture();
  const old = new Date('2026-10-01T00:00:00Z');
  utimesSync(join(dir, 'dag.new.json'), old, old);
  const got = await run(['--state-base', base, '--json']);
  assert.deepEqual(JSON.parse(got.out).queues.map((q) => q.repo), ['o/r']);
  assert.match(got.calls[0].join(' '), /i9: issue/);
});

test('main without readable review rounds falls back to the default depth latency and says so', async () => {
  const { base } = fixture();
  const { code, out } = await run(['--state-base', base, '--json'], { reviews: async () => { throw new Error('no review gate here'); } });
  assert.equal(code, 0);
  const json = JSON.parse(out);
  assert.equal(json.depth.source, 'default');
  assert.match(json.notes.join('\n'), /review rounds unreadable \(no review gate here\)/);
});

test('main reads a hand-rebuilt report, whose rows are under `rows`, for the PR that merged', async () => {
  const { base, dir } = fixture();
  rmSync(join(`${dir}-w1b`, 'state/reports/r.json'));
  put(join(`${dir}-w1b`, 'state/reports/rebuilt.json'), { synthesized: 'by hand', rows: [{ ref: 'o/r#1', status: 'succeeded', prNumber: 11 }] });
  const got = await run(['--state-base', base, '--json']);
  assert.match(got.calls[0].join(' '), /p11: pullRequest/);
  assert.equal(JSON.parse(got.out).depth.samples, 3);
});
