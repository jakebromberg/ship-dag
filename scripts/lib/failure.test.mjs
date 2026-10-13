// Tests for the engine-report failure routing + terminal-event extraction.
// Fixtures mirror real `--output-format stream-json` records and real
// `state/reports/*.json` rows captured from live engine runs — notably
// sd-20260831-162148, whose `failed`-with-a-PR row is the case that had no
// documented route at all. See the module doc.
// Run: node --test "skills/ship-dag/scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  terminalEvent,
  routeFailure,
  artifactStem,
  parseTerminalResultLine,
  createTranscriptScan,
  buildDiagnosis,
  stopCiStatus,
  resumeMode,
  ciStatusAfterProfile,
} from './failure.mjs';

const line = (obj) => `${JSON.stringify(obj)}\n`;

// The real terminal record from sd-20260831-162148's #620 transcript. Note
// `subtype: "success"` alongside `is_error: true` — the subtype alone lies.
// The real two-line death: the synthetic rate-limit assistant turn, then the
// result record. classifyFailureReason anchors on the former.
const quotaDeathTranscript = () =>
  line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } }) +
  line({ type: 'assistant', message: { role: 'assistant' }, error: 'rate_limit', is_api_error_message: true }) +
  sessionLimitResult();

const sessionLimitResult = () =>
  line({
    type: 'result',
    subtype: 'success',
    is_error: true,
    num_turns: 67,
    result: "You've hit your session limit · resets 7:10pm (America/Los_Angeles)",
  });

test('terminalEvent: reads the session-terminating result record', () => {
  const text = line({ type: 'system', subtype: 'init' }) + line({ type: 'assistant' }) + sessionLimitResult();
  assert.deepEqual(terminalEvent(text), {
    subtype: 'success',
    isError: true,
    numTurns: 67,
    reason: "You've hit your session limit · resets 7:10pm (America/Los_Angeles)",
  });
});

test('terminalEvent: reports isError independently of a "success" subtype', () => {
  // The trap: routing on subtype would have called this run a clean success.
  assert.equal(terminalEvent(sessionLimitResult()).subtype, 'success');
  assert.equal(terminalEvent(sessionLimitResult()).isError, true);
});

test('terminalEvent: null when the session died without writing a result record', () => {
  assert.equal(terminalEvent(line({ type: 'assistant' }) + line({ type: 'user' })), null);
  assert.equal(terminalEvent(''), null);
  assert.equal(terminalEvent(null), null);
});

test('terminalEvent: takes the LAST result record when a transcript carries several', () => {
  const text = line({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: 'first' }) + sessionLimitResult();
  assert.equal(terminalEvent(text).reason, "You've hit your session limit · resets 7:10pm (America/Los_Angeles)");
});

test('terminalEvent: ignores a hook-triggered result event, however late it lands', () => {
  // Hooks emit their own `result`-typed records, tagged with hook_event_name.
  // Taking the last result unconditionally would report a Stop hook's output as
  // the session's reason for dying.
  const text = sessionLimitResult() + line({ type: 'result', subtype: 'success', is_error: false, hook_event_name: 'Stop', result: 'hook ok' });
  assert.equal(terminalEvent(text).reason, "You've hit your session limit · resets 7:10pm (America/Los_Angeles)");
});

test('terminalEvent: skips unparseable and blank lines rather than throwing', () => {
  assert.equal(terminalEvent(`not json\n\n${sessionLimitResult()}`).numTurns, 67);
});

test('routeFailure: a succeeded row with a PR goes to the review gate', () => {
  assert.equal(routeFailure({ status: 'succeeded', prNumber: 625 }), 'review-gate');
});

test('routeFailure: a FAILED row that nevertheless opened a PR goes to the review gate, not a retry', () => {
  // sd-20260831-162148 #620: quota stop AFTER commit -> push -> PR. Retrying
  // would redo completed work; the PR is real and its checks were green.
  assert.equal(routeFailure({ status: 'failed', prNumber: 625, failureReason: 'rate-limited' }), 'review-gate');
  assert.equal(routeFailure({ status: 'failed', prNumber: 625, failureReason: null }), 'review-gate');
  assert.equal(routeFailure({ status: 'blocked', prNumber: 625 }), 'review-gate');
});

test('routeFailure: a succeeded row with no PR goes to find-pr, not the review gate', () => {
  // sd-20261008-153059 #87: the session pushed a self-chosen branch, so the
  // engine recorded `succeeded` with no PR; there is nothing to gate yet.
  assert.equal(routeFailure({ status: 'succeeded' }), 'find-pr');
  assert.equal(routeFailure({ status: 'succeeded', prNumber: null }), 'find-pr');
  assert.equal(routeFailure({ status: 'succeeded', prNumber: 0 }), 'find-pr');
  // Point A (#115): a PR is a positive integer, so a fractional number is no PR either.
  assert.equal(routeFailure({ status: 'succeeded', prNumber: 1.5 }), 'find-pr');
  assert.equal(routeFailure({ status: 'failed', prNumber: 1.5 }), 'point-B');
});

test('routeFailure: a rate-limited row with no PR resumes in place at point E', () => {
  assert.equal(routeFailure({ status: 'failed', prNumber: null, failureReason: 'rate-limited' }), 'point-E');
});

test('routeFailure: any other PR-less failure is a genuine implement stall — point B', () => {
  assert.equal(routeFailure({ status: 'failed', prNumber: null, failureReason: null }), 'point-B');
  assert.equal(routeFailure({ status: 'blocked', prNumber: null }), 'point-B');
});

test('routeFailure: prNumber 0 and an absent prNumber are both "no PR"', () => {
  // GitHub never issues PR 0, but a falsy-vs-nullish slip here would route a
  // PR-less stall to the review gate, which has no PR to review.
  assert.equal(routeFailure({ status: 'failed', prNumber: 0 }), 'point-B');
  assert.equal(routeFailure({ status: 'failed' }), 'point-B');
});

// Engine stops (claude-orchestrator#87): the row says why it stopped and at which stage.
// A PR decides first; with none, `resource` is checked before find-pr, so a stop is never read as a PR-less success.
const STOPS = [
  ['memory-critical', 'launch', 'pending'],
  ['memory-critical', 'retry', 'failed'],
  ['memory-critical', 'post-check', 'failed'],
  ['lease-wait', 'session', 'failed'],
];
for (const [failureReason, stopStage, status] of STOPS) {
  test(`routeFailure: ${failureReason} at ${stopStage}, no PR — resource, checked before find-pr`, () => {
    assert.equal(routeFailure({ status, prNumber: null, failureReason, stopStage }), 'resource');
    assert.equal(routeFailure({ status: 'succeeded', prNumber: null, failureReason, stopStage }), 'resource');
  });
  // A `retry` stop ran its check and it failed; any other stop never ran one, so it is unverified, not passing.
  test(`routeFailure: ${failureReason} at ${stopStage}, PR open — review-gate with ciStatus ${stopStage === 'retry' ? 'fail' : 'none'}`, () => {
    const row = { status, prNumber: 7, failureReason, stopStage };
    assert.equal(routeFailure(row), 'review-gate');
    assert.equal(stopCiStatus(row), stopStage === 'retry' ? 'fail' : 'none');
    assert.equal(buildDiagnosis({ row: { ref: 'o/r#1', ...row }, terminal: null }).ciStatus, stopStage === 'retry' ? 'fail' : 'none');
  });
}

test('stopCiStatus: a row that is not an infrastructure stop has no stop-derived ciStatus', () => {
  for (const row of [{ status: 'failed', prNumber: 7 }, { status: 'failed', prNumber: 7, failureReason: 'rate-limited' }, { status: 'succeeded', prNumber: 7 }]) assert.equal(stopCiStatus(row), null);
});

test('buildDiagnosis: forwards memory-critical and lease-wait with their stopStage, so telemetry can record them', () => {
  for (const [failureReason, stopStage, status] of STOPS) {
    const d = buildDiagnosis({ row: { ref: 'o/r#1', status, failureReason, stopStage }, terminal: null, rateLimited: false });
    assert.deepEqual([d.failureReason, d.stopStage, d.route, d.ciStatus], [failureReason, stopStage, 'resource', null]);
  }
});

test('buildDiagnosis: a row with no stop carries a null stopStage and no ciStatus', () => {
  const d = buildDiagnosis({ row: { ref: 'o/r#1', status: 'failed' }, terminal: null });
  assert.deepEqual([d.stopStage, d.ciStatus], [null, null]);
});

// The worktree decides how a PR-less stop recovers: work on disk is resumed in place (never re-run the engine into
// its branch); a clean tree with no commits is re-run on a spec filtered to the stopped refs.
for (const [name, state, want] of [
  ['commits', { commits: 2, dirty: false }, 'resume'],
  ['a dirty tree', { commits: 0, dirty: true }, 'resume'],
  ['commits and a dirty tree', { commits: 1, dirty: true }, 'resume'],
  ['a clean tree with no commits', { commits: 0, dirty: false }, 'filtered-rerun'],
]) {
  test(`resumeMode: ${name} → ${want}`, () => assert.equal(resumeMode(state), want));
}

// run-ci-profile.mjs's exit status for a PR whose engine check never ran (step 6.2's loop owns 75, the rerun).
for (const [name, code, opts, want] of [
  ['exit 0', 0, {}, 'pass'],
  ['exit 64 "no CI profile"', 64, { noProfile: true }, 'none'],
  ['exit 64, any other setup error', 64, {}, null],
  ['exit 75, no lease slot', 75, {}, null],
  ['the suite failing', 1, {}, 'fail'],
  ['a signal, 128+n', 137, {}, 'fail'],
]) {
  test(`ciStatusAfterProfile: ${name} → ${want}`, () => assert.equal(ciStatusAfterProfile(code, opts), want));
}

// SKILL.md step 5 runs diagnose-failure.mjs only for failed/blocked rows, so
// the routes nested under that bullet are reached only from such a row. A route
// that only a succeeded row produces needs a step-5 bullet of its own, or no
// instruction ever leads an agent to it.
test('SKILL.md step 5 nests exactly the failed/blocked routes under that bullet, and gives find-pr its own', () => {
  const skill = readFileSync(new URL('../../SKILL.md', import.meta.url), 'utf8');
  const step5 = skill.slice(skill.indexOf('\n### 5. '), skill.indexOf('\n### 6. ')).split('\n');
  const nested = step5.flatMap((l) => l.match(/^ {2}- `([A-Za-z-]+)`/)?.[1] ?? []);
  const failedOrBlocked = [{ status: 'failed', prNumber: 1 }, { status: 'failed', failureReason: 'rate-limited' }, { status: 'failed', failureReason: 'lease-wait' }, { status: 'failed' }, { status: 'blocked' }];
  assert.deepEqual(new Set(nested), new Set(failedOrBlocked.map(routeFailure)));
  assert.equal(step5.filter((l) => l.startsWith('- ') && l.includes('`find-pr`')).length, 1, 'step 5 has no top-level bullet for a find-pr row');
});

// Step 5's Green rule and its fix rule for a stopped row's CI, pinned: a `ciStatus: "none"` PR is not green until the CI profile run passes.
const step5Text = () => {
  const skill = readFileSync(new URL('../../SKILL.md', import.meta.url), 'utf8');
  return skill.slice(skill.indexOf('\n### 5. '), skill.indexOf('\n### 6. '));
};

test('SKILL.md step 5 Green rule: ciStatus "none" → run-ci-profile → pass, reusing step 6.2', () => {
  const green = step5Text().split('\n').find((l) => l.startsWith('- **Green**'));
  assert.match(green, /`ciStatus` is `"none"`/);
  assert.match(green, /run-ci-profile\.mjs/);
  assert.match(green, /step 6\.2/);
  assert.match(green, /Exit 0 sets `ciStatus: "pass"`/);
  assert.match(green, /Exit 64 with `no CI profile`[^.]*leaves `"none"`/);
  assert.match(green, /128 plus a signal number, sets `"fail"`/);
});

test('SKILL.md step 5: a red retry stop goes to point B quoting the check summary; the trigger covers pending rows', () => {
  const step5 = step5Text();
  assert.match(step5, /`memory-critical` stop at `retry` is such a failure \(`ciStatus: "fail"`\)[^.]*quote the engine's check summary/);
  assert.match(step5, /`pending` row carrying a `failureReason` — diagnose it/);
});

// --- the shared single-pass scan + canonical diagnosis -----------------------
// Both producers of a diagnosis (the engine's post-run digest, which streams a
// transcript it may never have to read again, and diagnose-failure.mjs, which
// reads one on demand) traverse the same transcript looking for the same two
// facts. These tests pin the one definition they share.

test('artifactStem: mirrors claude-orchestrator encodeRefForFilename exactly', () => {
  assert.equal(artifactStem('daisysguide/backend#620'), 'daisysguide%2Fbackend%23620');
  // Only %, / and # are escaped — NOT encodeURIComponent's full set. The two
  // agree on every valid GitHub ref, which is exactly why a mismatch here would
  // go unnoticed until some ref contained a character they disagree about.
  assert.equal(artifactStem('o/r#1?x'), 'o%2Fr%231?x');
  assert.equal(artifactStem('o/r#1%2F'), 'o%2Fr%231%252F');
});

test('parseTerminalResultLine: a genuine terminal result, and nothing else', () => {
  assert.deepEqual(parseTerminalResultLine(line({ type: 'result', subtype: 'success', is_error: true, num_turns: 4, result: 'boom' })), {
    subtype: 'success',
    isError: true,
    numTurns: 4,
    reason: 'boom',
  });
  assert.equal(parseTerminalResultLine(line({ type: 'assistant' })), null);
  assert.equal(parseTerminalResultLine(line({ type: 'result', hook_event_name: 'Stop' })), null);
  assert.equal(parseTerminalResultLine('not json'), null);
  assert.equal(parseTerminalResultLine(''), null);
});

test('createTranscriptScan: collects the terminal event and the rate-limit signature in ONE pass', () => {
  const scan = createTranscriptScan();
  for (const l of (quotaDeathTranscript()).split('\n')) scan.line(l);
  const { terminal, rateLimited } = scan.result();
  assert.equal(rateLimited, true);
  assert.equal(terminal.reason, "You've hit your session limit · resets 7:10pm (America/Los_Angeles)");
});

test('createTranscriptScan: an ordinary failing session is not a rate-limit death', () => {
  const scan = createTranscriptScan();
  scan.line(line({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'tests failed' }));
  assert.deepEqual(scan.result().rateLimited, false);
});

test('buildDiagnosis: the sd-20260831-162148 row — failed, PR open, quota, review-gate', () => {
  const d = buildDiagnosis({
    row: { ref: 'daisysguide/backend#620', status: 'failed', prNumber: 625, prUrl: 'https://x/625' },
    terminal: { subtype: 'success', isError: true, numTurns: 67, reason: 'limit' },
    rateLimited: true,
    exitCode: 1,
  });
  assert.equal(d.route, 'review-gate');
  assert.equal(d.failureReason, 'rate-limited');
  assert.equal(d.exitCode, 1);
  assert.equal(d.prNumber, 625);
});

test('buildDiagnosis: a structured failureReason on the row beats the transcript scan', () => {
  const d = buildDiagnosis({ row: { ref: 'o/r#1', status: 'failed', failureReason: 'rate-limited' }, terminal: null, rateLimited: false });
  assert.equal(d.failureReason, 'rate-limited');
  assert.equal(d.route, 'point-E');
});

test('buildDiagnosis: an unrecognized structured failureReason is not passed through', () => {
  // telemetry.mjs's failureReason enum is deliberately just rate-limited|null;
  // passing a future claude-orchestrator value through would make the append throw
  // and drop the very record it exists to capture.
  const d = buildDiagnosis({ row: { ref: 'o/r#1', status: 'failed', failureReason: 'disk-full' }, terminal: null, rateLimited: false });
  assert.equal(d.failureReason, null);
  assert.equal(d.route, 'point-B');
});

test('buildDiagnosis: clips a long terminal reason — this lands in an agent context', () => {
  const d = buildDiagnosis({ row: { ref: 'o/r#1', status: 'failed' }, terminal: { subtype: 's', isError: true, numTurns: 1, reason: 'x'.repeat(5000) }, rateLimited: false });
  assert.ok(d.terminal.reason.endsWith('…'));
});
