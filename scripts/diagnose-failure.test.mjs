// Tests for the one-read failure diagnosis CLI. The fixtures reproduce the
// shape of run sd-20260831-162148's state dir, including its 1.1MB-transcript
// trap: everything the main agent needed was in the last line of that file.
// Run: node --test "skills/ship-dag/scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { engineFixture } from './lib/engine-fixture.mjs';
import { logPathForRef, newestReportFile, digestPathForRef, diagnose, MAX_REASON_CHARS } from './diagnose-failure.mjs';

const line = (obj) => `${JSON.stringify(obj)}\n`;

const REF = 'daisysguide/backend#620';

const fixtures = [];
test.after(() => fixtures.forEach((fx) => fx.cleanup()));

/** A state dir laid out the way the engine writes one. */
function fixture({ rows, transcript, digest, ref = REF, reportName = '2026-08-31T23-43-43.528Z.json' } = {}) {
  const fx = engineFixture({ diag: {
    digests: digest === undefined ? [] : [{ ref, body: digest }],
    reports: rows ? { [reportName]: { configName: 'ship-dag-test', issues: rows } } : {},
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

test('newestReportFile: picks the newest report by mtime, ignoring the .md companion', () => {
  const dir = fixture({ rows: [] });
  const reports = join(dir, 'state', 'reports');
  writeFileSync(join(reports, 'older.json'), '{}');
  writeFileSync(join(reports, '2026-08-31T23-43-43.528Z.md'), '# not json');
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(reports, 'older.json'), old, old);
  assert.match(newestReportFile(dir), /2026-08-31T23-43-43\.528Z\.json$/);
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

test('diagnose: a torn digest falls back to computing, rather than failing', () => {
  const dir = fixture({ rows: [{ ref: REF, number: 620, status: 'failed', prNumber: 625 }], transcript: quotaDeath(), digest: '{"ref": "trunc' });
  const out = diagnose(dir, REF);
  assert.equal(out.source, 'computed');
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
