// Tests for the engine-report failure routing + terminal-event extraction.
// Fixtures mirror real `--output-format stream-json` records and real
// `state/reports/*.json` rows captured from live engine runs — notably
// sd-20260831-162148, whose `failed`-with-a-PR row is the case that had no
// documented route at all. See the module doc.
// Run: node --test "skills/ship-dag/scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalEvent, routeFailure } from './failure.mjs';

const line = (obj) => `${JSON.stringify(obj)}\n`;

// The real terminal record from sd-20260831-162148's #620 transcript. Note
// `subtype: "success"` alongside `is_error: true` — the subtype alone lies.
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

test('routeFailure: a succeeded row goes to the review gate', () => {
  assert.equal(routeFailure({ status: 'succeeded', prNumber: 625 }), 'review-gate');
});

test('routeFailure: a FAILED row that nevertheless opened a PR goes to the review gate, not a retry', () => {
  // sd-20260831-162148 #620: quota stop AFTER commit -> push -> PR. Retrying
  // would redo completed work; the PR is real and its checks were green.
  assert.equal(routeFailure({ status: 'failed', prNumber: 625, failureReason: 'rate-limited' }), 'review-gate');
  assert.equal(routeFailure({ status: 'failed', prNumber: 625, failureReason: null }), 'review-gate');
  assert.equal(routeFailure({ status: 'blocked', prNumber: 625 }), 'review-gate');
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
