// Tests for the rate-limit transcript parsing + preflight decision helpers.
// Run: node --test "skills/ship-dag/scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRateLimitEvents,
  latestRateLimitEvent,
  isRateLimitDeath,
  classifyFailureReason,
  preflightDecision,
} from './rate-limit.mjs';

const line = (obj) => `${JSON.stringify(obj)}\n`;

const event = (utilization, resetsAt, status = 'allowed') =>
  line({
    type: 'rate_limit_event',
    status,
    unifiedWindows: { five_hour: { utilization, resetsAt }, seven_day: { utilization: 0.1, resetsAt: '2026-09-05T00:00:00Z' } },
  });

test('parseRateLimitEvents: extracts five_hour utilization/resetsAt/status from rate_limit_event lines', () => {
  const text = line({ type: 'system', subtype: 'init' }) + event(0.42, '2026-08-31T23:00:00Z');
  const events = parseRateLimitEvents(text);
  assert.equal(events.length, 1);
  assert.equal(events[0].utilization, 0.42);
  assert.equal(events[0].resetsAt, '2026-08-31T23:00:00Z');
  assert.equal(events[0].status, 'allowed');
});

test('parseRateLimitEvents: skips malformed JSON lines and blank lines', () => {
  const text = 'not json\n\n' + event(0.5, '2026-08-31T23:00:00Z');
  assert.equal(parseRateLimitEvents(text).length, 1);
});

test('parseRateLimitEvents: ignores non-rate_limit_event lines even if they carry unifiedWindows-shaped data', () => {
  const text = line({ type: 'assistant', unifiedWindows: { five_hour: { utilization: 0.9 } } });
  assert.equal(parseRateLimitEvents(text).length, 0);
});

test('latestRateLimitEvent: returns the last event in the transcript, not the first', () => {
  const text = event(0.5, '2026-08-31T21:00:00Z') + event(0.99, '2026-08-31T23:45:00Z', 'rejected');
  const latest = latestRateLimitEvent(text);
  assert.equal(latest.utilization, 0.99);
  assert.equal(latest.status, 'rejected');
});

test('latestRateLimitEvent: null when the transcript has no rate_limit_event lines', () => {
  assert.equal(latestRateLimitEvent(line({ type: 'system', subtype: 'init' })), null);
});

test('isRateLimitDeath: true on a rejected rate_limit_event', () => {
  assert.equal(isRateLimitDeath(event(1.0, '2026-08-31T23:45:00Z', 'rejected')), true);
});

test('isRateLimitDeath: true on the synthetic final-result marker even without a rejected event', () => {
  const text = line({ type: 'result', subtype: 'success', result: "You've hit your session limit for this 5-hour window." });
  assert.equal(isRateLimitDeath(text), true);
});

test('isRateLimitDeath: false on an ordinary successful transcript', () => {
  const text = event(0.5, '2026-08-31T21:00:00Z') + line({ type: 'result', subtype: 'success', result: 'done' });
  assert.equal(isRateLimitDeath(text), false);
});

test('classifyFailureReason: prefers a structured failureReason on the report row when present', () => {
  const row = { ref: 'o/r#1', status: 'failed', failureReason: 'rate-limited' };
  assert.equal(classifyFailureReason(row, 'irrelevant transcript text'), 'rate-limited');
});

test('classifyFailureReason: falls back to transcript parsing when the report row has no failureReason', () => {
  const row = { ref: 'o/r#1', status: 'failed' };
  const text = line({ type: 'result', subtype: 'success', result: "You've hit your session limit" });
  assert.equal(classifyFailureReason(row, text), 'rate-limited');
});

test('classifyFailureReason: null when neither the report row nor the transcript indicate a rate-limit death', () => {
  assert.equal(classifyFailureReason({ ref: 'o/r#1', status: 'failed' }, 'some other failure\n'), null);
  assert.equal(classifyFailureReason({ ref: 'o/r#1', status: 'failed' }, null), null);
});

const NOW = new Date('2026-08-31T23:00:00Z');

test('preflightDecision: proceeds when no utilization data is readable (fail-open)', () => {
  const d = preflightDecision({ utilization: null, resetsAt: null, now: NOW });
  assert.equal(d.action, 'proceed');
  assert.equal(d.reason, 'no-utilization-data');
});

test('preflightDecision: proceeds when utilization is below the threshold', () => {
  const d = preflightDecision({ utilization: 0.5, resetsAt: '2026-09-01T00:00:00Z', now: NOW });
  assert.equal(d.action, 'proceed');
  assert.equal(d.reason, 'below-threshold');
});

test('preflightDecision: waits when above threshold and the window resets within waitMaxMinutes', () => {
  const d = preflightDecision({ utilization: 0.85, resetsAt: '2026-08-31T23:20:00Z', now: NOW });
  assert.equal(d.action, 'wait');
  assert.equal(d.resetsAt, '2026-08-31T23:20:00Z');
  assert.ok(Math.abs(d.minutesUntilReset - 20) < 1e-6);
});

test('preflightDecision: surfaces a HITL fork when above threshold and the reset is far off', () => {
  const d = preflightDecision({ utilization: 0.95, resetsAt: '2026-09-01T02:00:00Z', now: NOW });
  assert.equal(d.action, 'hitl');
  assert.equal(d.reason, 'reset-far');
});

test('preflightDecision: surfaces a HITL fork when above threshold with no resetsAt to wait on', () => {
  const d = preflightDecision({ utilization: 0.95, resetsAt: null, now: NOW });
  assert.equal(d.action, 'hitl');
  assert.equal(d.reason, 'above-threshold-no-reset-time');
});

test('preflightDecision: custom threshold and waitMaxMinutes are honored', () => {
  const d = preflightDecision({ utilization: 0.6, resetsAt: '2026-09-01T00:00:00Z', now: NOW, threshold: 0.5 });
  assert.equal(d.action, 'hitl');
  const d2 = preflightDecision({ utilization: 0.85, resetsAt: '2026-08-31T23:50:00Z', now: NOW, waitMaxMinutes: 60 });
  assert.equal(d2.action, 'wait');
});
