// Tests for the one-read failure diagnosis CLI. The fixtures reproduce the
// shape of run sd-20260831-162148's state dir, including its 1.1MB-transcript
// trap: everything the main agent needed was in the last line of that file.
// Run: node --test "skills/ship-dag/scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { engineFixture, stamped } from './lib/engine-fixture.mjs';
import { logPathForRef, owningReport, digestPathForRef, diagnose, MAX_REASON_CHARS } from './diagnose-failure.mjs';

const line = (obj) => `${JSON.stringify(obj)}\n`;

const REF = 'daisysguide/backend#620';

const fixtures = [];
test.after(() => fixtures.forEach((fx) => fx.cleanup()));

/** A state dir laid out the way the engine writes one. */
function fixture({ rows, transcript, digest, ref = REF, reportName = '2026-08-31T23-43-43.528Z.json' } = {}) {
  const fx = engineFixture({ diag: {
    digests: digest === undefined ? [] : [{ ref, body: digest }],
    reports: rows ? { [reportName]: { configName: 'ship-dag-test', startedAt: '2026-08-31T23:43:43.528Z', issues: rows } } : {},
    files: { 'state/logs/.keep': '', ...(transcript !== undefined && { [`state/logs/issue-${encodeURIComponent(ref)}.log`]: transcript }) },
  } });
  fixtures.push(fx);
  return fx.dirs.diag;
}

const quotaDeath = () =>
  line({ type: 'assistant', message: { role: 'assistant' }, error: 'rate_limit', is_api_error_message: true }) +
  line({ type: 'result', subtype: 'success', is_error: true, num_turns: 67, result: "You've hit your session limit · resets 7:10pm (America/Los_Angeles)" });

test('logPathForRef: percent-encodes the composite ref the way the engine names its logs', () => {
  assert.equal(logPathForRef('/s', REF), '/s/state/logs/issue-daisysguide%2Fbackend%23620.log');
});

/** A state dir of `reports` (stem -> {startedAt, rows}) and, optionally, a digest for REF; `files` writes anything else. */
function waves(reports, { digest, files } = {}) {
  const fx = engineFixture({ diag: {
    reports: Object.fromEntries(Object.entries(reports).map(([stem, { startedAt, rows, mtime }]) => [`${stem}.json`, mtime ? stamped(mtime, { startedAt, issues: rows }) : { startedAt, issues: rows }])),
    digests: digest ? [{ ref: REF, body: digest }] : [],
    files,
  } });
  fixtures.push(fx);
  return fx.dirs.diag;
}
const W1 = '2026-10-08T19:00:00.000Z';
const W2 = '2026-10-08T20:00:00.000Z';
const row = (over = {}) => ({ ref: REF, number: 620, status: 'failed', ...over });
const quiet = { warn: () => {} };

test('owningReport: the latest report, by startedAt, that lists the ref as its own row, ignoring the .md companion and a report that only carries the row over', () => {
  const dir = waves({
    a: { startedAt: W1, rows: [row({ ran: true, prNumber: 9 })] },
    b: { startedAt: W2, rows: [row({ ran: false, prNumber: 9 })] }, // carries a's row over
    c: { startedAt: '2026-10-08T21:00:00.000Z', rows: [row({ ref: 'o/r#2' })] }, // lists another ref
  }, { files: { 'state/reports/d.md': '# not json' } });
  assert.equal(owningReport(dir, REF, quiet).id, 'a');
  assert.equal(owningReport(dir, 'o/r#2', quiet).id, 'c');
});

test('owningReport: orders by startedAt, not by mtime or name; a tie in mtime does not pick the oldest name', () => {
  const dir = waves({
    a: { startedAt: W2, rows: [row()], mtime: W1 },
    b: { startedAt: W1, rows: [row({ status: 'pending', ran: false })], mtime: W2 },
  });
  assert.equal(owningReport(dir, REF, quiet).id, 'a');
  const tie = waves({ a: { startedAt: W1, rows: [row()], mtime: W1 }, b: { startedAt: W2, rows: [row({ status: 'pending', ran: false })], mtime: W1 } });
  assert.equal(owningReport(tie, REF, quiet).id, 'b');
});

test('owningReport: the only report to list a ref owns it, whatever its row says; an unlisted ref gives null', () => {
  const dir = waves({ b: { startedAt: W2, rows: [row({ ran: false })] } });
  assert.equal(owningReport(dir, REF, quiet).id, 'b');
  assert.equal(owningReport(dir, 'o/r#7', quiet), null);
});

test('diagnose: a ref of an earlier wave is still diagnosed by its digest after a later wave writes a report that does not list it', () => {
  const digest = { ref: REF, status: 'failed', failureReason: 'rate-limited', route: 'point-E', reportId: 'w1' };
  const dir = waves({ w1: { startedAt: W1, rows: [row({ ran: true })] }, w2: { startedAt: W2, rows: [row({ ref: 'o/r#2', status: 'succeeded' })] } }, { digest });
  const out = diagnose(dir, REF, quiet);
  assert.equal(out.source, 'digest');
  assert.equal(out.route, 'point-E');
});

test('diagnose: a digest kept for a row a later report carries over is served, because its stamp names the report that owns the event', () => {
  const digest = { ref: REF, status: 'failed', prNumber: 9, exitCode: 1, route: 'review-gate', reportId: 'w1' };
  const dir = waves({
    w1: { startedAt: W1, rows: [row({ ran: true, prNumber: 9 })] },
    w2: { startedAt: W2, rows: [row({ ran: false, prNumber: 9 })] },
  }, { digest });
  const out = diagnose(dir, REF, quiet);
  assert.equal(out.source, 'digest');
  assert.equal(out.exitCode, 1);
});

test('diagnose: a digest stamped by a report that is not the owner is recomputed from the owner, even when the owner is not the newest report', () => {
  const digest = { ref: REF, status: 'failed', route: 'point-B', reportId: 'w1' };
  const dir = waves({
    w1: { startedAt: W1, rows: [row()] },
    w2: { startedAt: W2, rows: [row({ status: 'pending', ran: false, failureReason: 'lease-wait' })] },
    w3: { startedAt: '2026-10-08T21:00:00.000Z', rows: [row({ ref: 'o/r#2' })] },
  }, { digest });
  const out = diagnose(dir, REF, quiet);
  assert.equal(out.source, 'report');
  assert.equal(out.status, 'pending');
  assert.match(out.report, /w2\.json$/);
});

test('diagnose: a tie in mtime does not discard the digest of the later report', () => {
  const digest = { ref: REF, status: 'pending', route: 'resource', reportId: 'b' };
  const dir = waves({
    a: { startedAt: W1, rows: [row()], mtime: W1 },
    b: { startedAt: W2, rows: [row({ status: 'pending', ran: false, failureReason: 'lease-wait' })], mtime: W1 },
  }, { digest });
  assert.equal(diagnose(dir, REF, quiet).route, 'resource');
});

test('diagnose: a torn report, or one with a row that has no ref, is skipped with a warning rather than thrown over or trusted', () => {
  // c is refused for its row with no ref but still parses its report and start, so it counts, as in ingest and audit: it owns REF.
  const digest = { ref: REF, status: 'failed', route: 'point-B', reportId: 'c' };
  const dir = waves({ a: { startedAt: W1, rows: [row()] }, c: { startedAt: W2, rows: [row({ status: 'pending' }), { number: 3 }] } }, { digest, files: { 'state/reports/b.json': '{"iss' } });
  const warnings = [];
  assert.equal(diagnose(dir, REF, { warn: (m) => warnings.push(m) }).source, 'digest');
  assert.equal(warnings.length, 2);
  assert.match(warnings.join('\n'), /b\.json[^]*c\.json|c\.json[^]*b\.json/);
});

test('diagnose: the sd-20260831-162148 case — failed, but a PR is open, so it routes to the review gate', () => {
  const dir = fixture({
    rows: [{ ref: REF, number: 620, status: 'failed', prNumber: 625, prUrl: 'https://github.com/daisysguide/backend/pull/625' }],
    transcript: quotaDeath(),
  });
  const out = diagnose(dir, REF);
  assert.equal(out.status, 'failed');
  assert.equal(out.prNumber, 625);
  assert.equal(out.failureReason, 'rate-limited');
  assert.equal(out.route, 'review-gate');
  assert.equal(out.terminal.isError, true);
  assert.equal(out.terminal.reason, "You've hit your session limit · resets 7:10pm (America/Los_Angeles)");
});

test('diagnose: a PR-less quota death routes to point E', () => {
  const dir = fixture({ rows: [{ ref: REF, number: 620, status: 'failed' }], transcript: quotaDeath() });
  assert.equal(diagnose(dir, REF).route, 'point-E');
});

test('diagnose: a PR-less ordinary failure routes to point B', () => {
  const dir = fixture({
    rows: [{ ref: REF, number: 620, status: 'failed' }],
    transcript: line({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 12, result: 'tests failed' }),
  });
  const out = diagnose(dir, REF);
  assert.equal(out.failureReason, null);
  assert.equal(out.route, 'point-B');
  assert.equal(out.terminal.reason, 'tests failed');
});

test('diagnose: a missing transcript is not fatal — the row still routes', () => {
  const dir = fixture({ rows: [{ ref: REF, number: 620, status: 'failed', prNumber: 625 }] });
  const out = diagnose(dir, REF);
  assert.equal(out.terminal, null);
  assert.equal(out.failureReason, null);
  assert.equal(out.route, 'review-gate');
});

test('diagnose: an unknown ref throws and names the refs the report does carry', () => {
  const dir = fixture({ rows: [{ ref: REF, number: 620, status: 'failed' }] });
  assert.throws(() => diagnose(dir, 'daisysguide/backend#999'), /daisysguide\/backend#620/);
});

test('diagnose: a state dir with no report at all throws rather than guessing', () => {
  const dir = fixture({ transcript: quotaDeath() });
  assert.throws(() => diagnose(dir, REF), /no engine report/i);
});

test('diagnose: a long terminal reason is truncated — this output goes straight into an agent context', () => {
  const dir = fixture({
    rows: [{ ref: REF, number: 620, status: 'failed' }],
    transcript: line({ type: 'result', subtype: 'success', is_error: true, num_turns: 9, result: 'x'.repeat(5000) }),
  });
  const { terminal } = diagnose(dir, REF);
  assert.equal(terminal.reason.length, MAX_REASON_CHARS + 1);
  assert.ok(terminal.reason.endsWith('…'));
});

// --- the two producers agree, and the cheap one wins ------------------------

test('diagnose: prefers the engine-written digest over re-reading the transcript', () => {
  const dir = fixture({
    rows: [{ ref: REF, number: 620, status: 'failed' }], transcript: quotaDeath(),
    digest: { ref: REF, status: 'failed', prNumber: 625, failureReason: 'rate-limited', route: 'review-gate', exitCode: 1, terminal: null },
  });
  const out = diagnose(dir, REF);
  assert.equal(out.source, 'digest');
  assert.equal(out.route, 'review-gate');
  assert.equal(out.exitCode, 1);
});

test('diagnose: a digest stamped with an earlier report is recomputed from the newest report; an unstamped or newest-stamped one is returned', () => {
  const stem = '2026-08-31T23-43-43.528Z';
  const rows = [{ ref: REF, number: 620, status: 'pending', ran: false }];
  const digest = (reportId) => ({ ref: REF, status: 'failed', failureReason: 'rate-limited', route: 'point-E', ...(reportId && { reportId }) });
  const stale = diagnose(fixture({ rows, digest: digest('2026-08-30T00-00-00.000Z') }), REF);
  assert.equal(stale.source, 'report');
  assert.equal(stale.status, 'pending');
  for (const reportId of [undefined, stem]) assert.equal(diagnose(fixture({ rows, digest: digest(reportId) }), REF).source, 'digest');
});

test('diagnose: a torn digest falls back to computing, rather than failing', () => {
  const dir = fixture({ rows: [{ ref: REF, number: 620, status: 'failed', prNumber: 625 }], transcript: quotaDeath(), digest: '{"ref": "trunc' });
  const out = diagnose(dir, REF);
  assert.equal(out.source, 'report');
  assert.equal(out.route, 'review-gate');
});

test('diagnose: both producers agree on the same run', async () => {
  // The reconciliation's actual contract: the engine's streaming pass and this
  // script's string fold must not disagree about one transcript.
  const { writeFailureDigests } = await import('./engine/failure-digest.mjs');
  const rows = [{ ref: REF, number: 620, status: 'failed', prNumber: 625 }];
  const dir = fixture({ rows, transcript: quotaDeath() });
  const computed = diagnose(dir, REF);
  await writeFailureDigests({ configDir: join(dir, 'state'), report: { issues: rows } });
  const fromDigest = diagnose(dir, REF);

  assert.equal(fromDigest.source, 'digest');
  for (const k of ['ref', 'status', 'prNumber', 'failureReason', 'route']) {
    assert.deepEqual(fromDigest[k], computed[k], `producers disagree on ${k}`);
  }
  assert.deepEqual(fromDigest.terminal, computed.terminal);
});

/** A run family: `base` (sd-X) and its retry dir (sd-X-b), each with its own reports, digest and transcript for REF. */
function family({ base, retry }) {
  const spec = ({ id, startedAt, rows, digest, transcript }) => ({
    reports: { [`${id}.json`]: { startedAt, issues: rows } },
    digests: digest ? [{ ref: REF, body: digest }] : [],
    files: transcript === undefined ? {} : { [`state/logs/issue-${encodeURIComponent(REF)}.log`]: transcript },
  });
  const fx = engineFixture({ 'sd-20261001-000000': spec(base), 'sd-20261001-000000-b': spec(retry) });
  fixtures.push(fx);
  return fx.dirs;
}
const maxTurns = () => line({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 80, result: 'Reached max turns' });
const WAVES = {
  base: { id: 'w1', startedAt: W1, rows: [row({ ran: true })], digest: { ref: REF, status: 'failed', failureReason: 'rate-limited', route: 'point-E', reportId: 'w1' }, transcript: quotaDeath() },
  retry: { id: 'w2', startedAt: W2, rows: [row({ ran: true })], transcript: maxTurns() },
};

test('diagnose: an owner in a sibling dir is diagnosed from that dir, not joined to the given dir\'s digest and transcript', () => {
  const d = family(WAVES);
  const out = diagnose(d['sd-20261001-000000'], REF, quiet);
  assert.equal(out.source, 'report');
  assert.equal(out.report, join(d['sd-20261001-000000-b'], 'state', 'reports', 'w2.json'));
  assert.equal(out.transcript, logPathForRef(d['sd-20261001-000000-b'], REF));
  assert.notEqual(out.failureReason, 'rate-limited');
  assert.notEqual(out.route, 'point-E');
  assert.equal(out.terminal.subtype, 'error_max_turns');
});

test('diagnose: the owner\'s dir has no transcript for the row, so the result says null rather than borrowing the given dir\'s', () => {
  const d = family({ ...WAVES, retry: { ...WAVES.retry, transcript: undefined } });
  const out = diagnose(d['sd-20261001-000000'], REF, quiet);
  assert.equal(out.report, join(d['sd-20261001-000000-b'], 'state', 'reports', 'w2.json'));
  assert.equal(out.transcript, null);
  assert.equal(out.failureReason ?? null, null);
});

test('diagnose: the owner\'s own digest in a sibling dir is served, and the given dir\'s digest stamped by an older report is not', () => {
  const retry = { ...WAVES.retry, digest: { ref: REF, status: 'failed', failureReason: 'max-turns', route: 'point-B', reportId: 'w2' } };
  const d = family({ ...WAVES, retry });
  const out = diagnose(d['sd-20261001-000000'], REF, quiet);
  assert.equal(out.source, 'digest');
  assert.equal(out.digest, digestPathForRef(d['sd-20261001-000000-b'], REF));
  assert.equal(out.route, 'point-B');
});

test('diagnose: given the retry dir, an owner in the base dir is read from the base dir', () => {
  const d = family({ base: { ...WAVES.base, startedAt: W2, rows: [row({ ran: true })] }, retry: { ...WAVES.retry, startedAt: W1, rows: [row({ ran: true })] } });
  const out = diagnose(d['sd-20261001-000000-b'], REF, quiet);
  assert.equal(out.source, 'digest');
  assert.equal(out.digest, digestPathForRef(d['sd-20261001-000000'], REF));
  assert.equal(out.failureReason, 'rate-limited');
});
