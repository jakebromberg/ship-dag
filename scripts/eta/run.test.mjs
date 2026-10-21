// Tests for the ETA CLI: locating a run, reading its state dirs, the one batched GraphQL query, and the degraded
// path when gh is unavailable. Fixtures are real dirs under a temp state base; `gh` is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { metadataPathForRef } from '../lib/failure.mjs';
import { scopedEngineFixture, stamped } from '../lib/engine-fixture.mjs';
import { fsIo, main } from './run.mjs';
import { familyDirs, latestRun, runStartFromId, liveQuery } from './state.mjs';

const RUN = 'sd-20261017-080000';

const started = (ref, at) => [metadataPathForRef('.', ref), { startedAt: at }];
const wave1b = (reports = { 'r.json': { startedAt: '2026-10-17T17:00:00.000Z', issues: [{ ref: 'o/r#1', number: 1, status: 'succeeded', prNumber: 11 }] } }) => ({
  reports,
  files: Object.fromEntries([
    started('o/r#1', '2026-10-17T17:00:00.000Z'), started('o/r#2', '2026-10-17T17:00:00.000Z'), started('o/r#3', '2026-10-17T17:10:00.000Z'),
  ]),
});

/**
 * A state base holding one run with two family dirs: o/r#1 merged, o/r#2 and o/r#3 open, o/r#4 blocked. Each of
 * #1-#3 has a latest engine start and a passing review round, 20, 30 and 40 minutes after it. `dirs` adds more
 * dirs (name → engineFixture spec), `w1bReports` replaces the -w1b dir's reports, and `dagNewAt` pins dag.new.json's mtime.
 */
function fixture({ dirs = {}, w1bReports, dagNewAt } = {}) {
  const dagNew = {
    repo: 'o/r', nodes: ['o/r#2', 'o/r#3', 'o/r#4'].map((ref) => ({ ref })), edges: [], done: ['o/r#1'],
    members: ['o/r#1', 'o/r#2', 'o/r#3', 'o/r#4'],
  };
  const { base, dirs: made } = scopedEngineFixture({
    [RUN]: {
      files: {
        'dag.json': { repo: 'o/r', nodes: [{ ref: 'o/r#9' }], edges: [], done: [] },
        'dag.new.json': dagNewAt ? stamped(dagNewAt, dagNew) : dagNew,
        'plan.new.json': { waves: [['o/r#2', 'o/r#3']], blocked: [{ ref: 'o/r#4', reason: 'external', missing: ['x/y#1'] }], cyclic: [] },
        [metadataPathForRef('.', 'o/r#1')]: { startedAt: '2026-10-17T16:00:00.000Z' },
      },
      reviews: [['o/r#1', '17:20'], ['o/r#2', '17:30'], ['o/r#3', '17:50']].map(([ref, passed]) => ({ ref, findings: [], at: `2026-10-17T${passed}:00Z` })),
    },
    [`${RUN}-w1b`]: wave1b(w1bReports),
    // An older run, and a family dir of the newer one, must not be picked as the newest run.
    'sd-20261001-090000': {},
    ...dirs,
  });
  return { base, dir: made[RUN] };
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

async function run(argv, { gh = async () => JSON.stringify(answer), reviews } = {}) {
  const out = [];
  const err = [];
  const calls = [];
  const code = await main(argv, {
    env: { XDG_STATE_HOME: '/nope', HOME: '/nope' },
    now: Date.parse('2026-10-17T18:00:00Z'),
    gh: async (args) => { calls.push(args); return gh(args); },
    reviews,
    stdout: (s) => out.push(s), stderr: (s) => err.push(s),
  });
  return { code, out: out.join('\n'), err: err.join('\n'), calls };
}

test('latestRun picks the newest run by the start its id encodes, skipping wave dirs', async () => {
  const { base } = fixture({ dirs: { [`${RUN}-w9`]: {} } });
  assert.equal(await latestRun(fsIo, base), RUN);
});

test('latestRun skips a -w1aa dir and familyDirs includes it, so the two agree on every wave-dir name', async () => {
  const { base } = fixture({ dirs: { [`${RUN}-w1aa`]: {} } });
  assert.equal(await latestRun(fsIo, base), RUN);
  assert.ok((await familyDirs(fsIo, base, RUN)).includes(`${base}/${RUN}-w1aa`));
});

test('latestRun skips a newer dir that holds no fetched DAG (a board dir, a retry, a run that kept its spec elsewhere)', async () => {
  const { base } = fixture({ dirs: { [`${RUN}-board`]: {}, 'sd-20261018-090000': {} } });
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
  const { text: q, aliasOf } = liveQuery(['o/r#1', 'o/r#2', 'p/q#7'], [{ repo: 'o/r', number: 11 }]);
  assert.deepEqual([...aliasOf], [['o/r', 'r0'], ['p/q', 'r1']]);
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
  const { base } = scopedEngineFixture({});
  const got = await run(['--state-base', base]);
  assert.equal(got.code, 1);
  assert.match(got.err, /no ship-dag run under/);
});

test('main exits 1 when the run has no fetched DAG', async () => {
  const { base } = scopedEngineFixture({ [RUN]: {} });
  const got = await run(['--state-base', base, '--run', RUN]);
  assert.equal(got.code, 1);
  assert.match(got.err, /no dag\.json/);
});

test('main reads the newer of dag.json and dag.new.json', async () => {
  const { base } = fixture({ dagNewAt: '2026-10-01T00:00:00Z' });
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
  const { base } = fixture({ w1bReports: { 'rebuilt.json': { synthesized: 'by hand', rows: [{ ref: 'o/r#1', status: 'succeeded', prNumber: 11 }] } } });
  const got = await run(['--state-base', base, '--json']);
  assert.match(got.calls[0].join(' '), /p11: pullRequest/);
  assert.equal(JSON.parse(got.out).queues[0].merged, 1);
  assert.equal(JSON.parse(got.out).depth.samples, 3);
});

test('main keeps the data of a GraphQL answer that also holds errors, and names the refs it could not resolve', async () => {
  const { base } = fixture();
  const partial = { ...answer, errors: [{ type: 'NOT_FOUND', path: ['r0', 'i3'], message: 'Could not resolve to an Issue with the number of 3.' }] };
  const gh = async () => { throw Object.assign(new Error('Command failed: gh api graphql -f query=query { ... }\ngh: Could not resolve'), { code: 1, stdout: JSON.stringify(partial), stderr: 'gh: Could not resolve to an Issue with the number of 3.\n' }); };
  const got = await run(['--state-base', base, '--json'], { gh });
  assert.equal(got.code, 0, got.err);
  const json = JSON.parse(got.out);
  assert.equal(json.queues[0].merged, 1, 'the merge GitHub did answer still counts');
  assert.ok(!json.notes.some((n) => /gh unavailable/.test(n)), json.notes.join('; '));
  assert.ok(json.notes.some((n) => /r0\.i3/.test(n)), json.notes.join('; '));
});

test('main names gh\'s own error, not the command line with the whole query, when the call fails', async () => {
  const { base } = fixture();
  const gh = async () => { throw Object.assign(new Error('Command failed: gh api graphql -f query=query { r0: repository(owner: "o") }\ngh: HTTP 401'), { code: 1, stdout: '', stderr: 'gh: HTTP 401: Bad credentials\n' }); };
  const got = await run(['--state-base', base], { gh });
  assert.match(got.out, /Note: gh unavailable \(gh: HTTP 401: Bad credentials\)/);
  assert.doesNotMatch(got.out, /query=/);
});

test('main lists a ticket the plan blocked only while it is still open', async () => {
  const { base } = fixture();
  const closed = structuredClone(answer);
  closed.data.r0.i4 = { state: 'CLOSED', stateReason: 'COMPLETED', closedAt: '2026-10-17T17:45:00Z', closedByPullRequestsReferences: { nodes: [] } };
  const got = await run(['--state-base', base, '--json'], { gh: async () => JSON.stringify(closed) });
  assert.deepEqual(JSON.parse(got.out).blocked, []);
});

test('main takes a ticket\'s PR from its newest report, across retry dirs and wave dirs past -w9', async () => {
  const report = (startedAt, prNumber) => ({ 'a.json': { startedAt, issues: [{ ref: 'o/r#1', status: 'succeeded', prNumber }] } });
  const { base } = fixture({
    w1bReports: {},
    dirs: {
      [`${RUN}-w2`]: { reports: report('2026-10-17T16:10:00.000Z', 12) },
      [`${RUN}-w10`]: { reports: report('2026-10-17T16:50:00.000Z', 13) },
      [`${RUN}-b`]: { reports: report('2026-10-17T17:00:00.000Z', 11) },
    },
  });
  const got = await run(['--state-base', base, '--json']);
  const query = got.calls[0].join(' ');
  assert.match(query, /p11: pullRequest/);
  assert.doesNotMatch(query, /p1[23]: pullRequest/);
});

test('liveQuery quotes repo names as GraphQL strings', () => {
  assert.match(liveQuery(['o/r"x#1'], []).text, /owner: "o", name: "r\\"x"/);
});

test('familyDirs follows runFamily: case and prefix fold, chained retries and a prefix-sharing run do not', async () => {
  const mine = [`${RUN}-w2`, `${RUN}-b`, `${RUN}-r2`, `${RUN}-resume`, `ship-dag-${RUN}-w3`, `${RUN.toUpperCase()}-W4`, `${RUN}-w37aa`];
  const others = [`${RUN}-b-c`, `${RUN}-label`, `${RUN}x`];
  const { base } = scopedEngineFixture(Object.fromEntries([RUN, ...mine, ...others].map((name) => [name, {}])));
  const dirs = await familyDirs(fsIo, base, RUN);
  assert.deepEqual(dirs, [RUN, ...mine.sort()].map((n) => `${base}/${n}`));
});
