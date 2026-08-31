// Tests for the rate-limit transcript parsing + preflight decision helpers.
// Fixtures mirror real `--output-format stream-json` records captured from
// live engine transcripts, not a guessed schema — see the module doc.
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

// A real early-session event: no unifiedWindows breakdown yet, no utilization
// figure at all (below the CLI's own warning threshold).
const bareEvent = (rateLimitType, resetsAtSec, status = 'allowed') =>
  line({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt: resetsAtSec, rateLimitType } });

// A real mature event carrying the unifiedWindows breakdown for both windows.
const unifiedEvent = (fiveHour, sevenDay, status = 'allowed_warning', rateLimitType = 'five_hour') =>
  line({
    type: 'rate_limit_event',
    rate_limit_info: {
      status,
      rateLimitType,
      resetsAt: rateLimitType === 'five_hour' ? fiveHour.resetsAt : sevenDay.resetsAt,
      utilization: rateLimitType === 'five_hour' ? fiveHour.utilization : sevenDay.utilization,
      unifiedWindows: { five_hour: fiveHour, seven_day: sevenDay },
    },
  });

const deathLine = () =>
  line({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit · resets 1pm (America/Los_Angeles)" }] },
    error: 'rate_limit',
    is_api_error_message: true,
  });

test('parseRateLimitEvents: reads five_hour utilization/resetsAt out of rate_limit_info.unifiedWindows, converting epoch seconds to ISO', () => {
  const text = line({ type: 'system', subtype: 'init' }) + unifiedEvent({ utilization: 0.42, resetsAt: 1788206400 }, { utilization: 0.1, resetsAt: 1788724800 });
  const events = parseRateLimitEvents(text);
  assert.equal(events.length, 1);
  assert.equal(events[0].utilization, 0.42);
  assert.equal(events[0].resetsAt, new Date(1788206400 * 1000).toISOString());
  assert.equal(events[0].status, 'allowed_warning');
});

test('parseRateLimitEvents: falls back to the flat fields when rateLimitType is five_hour and unifiedWindows is absent', () => {
  const text = line({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9, resetsAt: 1788206400 },
  });
  const events = parseRateLimitEvents(text);
  assert.equal(events.length, 1);
  assert.equal(events[0].utilization, 0.9);
  assert.equal(events[0].resetsAt, new Date(1788206400 * 1000).toISOString());
});

test('parseRateLimitEvents: a seven_day-only event with no unifiedWindows carries no five-hour utilization', () => {
  const events = parseRateLimitEvents(bareEvent('seven_day', 1788724800));
  assert.equal(events.length, 1);
  assert.equal(events[0].utilization, null);
  assert.equal(events[0].resetsAt, null);
  assert.equal(events[0].status, 'allowed');
});

test('parseRateLimitEvents: skips malformed JSON lines and blank lines', () => {
  const text = 'not json\n\n' + bareEvent('five_hour', 1788206400);
  assert.equal(parseRateLimitEvents(text).length, 1);
});

test('parseRateLimitEvents: ignores non-rate_limit_event lines even if they carry lookalike fields', () => {
  const text = line({ type: 'assistant', rate_limit_info: { utilization: 0.9 } });
  assert.equal(parseRateLimitEvents(text).length, 0);
});

test('latestRateLimitEvent: returns the last event that actually carries five-hour data, not just the last line', () => {
  const text =
    unifiedEvent({ utilization: 0.5, resetsAt: 1788206400 }, { utilization: 0.2, resetsAt: 1788724800 }) +
    bareEvent('seven_day', 1788724800) + // last line, but no five-hour data
    unifiedEvent({ utilization: 1, resetsAt: 1788206400 }, { utilization: 0.3, resetsAt: 1788724800 }, 'rejected');
  const latest = latestRateLimitEvent(text);
  assert.equal(latest.utilization, 1);
  assert.equal(latest.status, 'rejected');
});

test('latestRateLimitEvent: null when the transcript has no rate_limit_event with five-hour data', () => {
  assert.equal(latestRateLimitEvent(bareEvent('seven_day', 1788724800)), null);
  assert.equal(latestRateLimitEvent(line({ type: 'system', subtype: 'init' })), null);
});

test('isRateLimitDeath: true on the CLI synthetic rate-limit assistant turn', () => {
  const text = unifiedEvent({ utilization: 0.99, resetsAt: 1788206400 }, { utilization: 0.34, resetsAt: 1788724800 }, 'allowed_warning') + deathLine();
  assert.equal(isRateLimitDeath(text), true);
});

test('isRateLimitDeath: true on a rejected rate_limit_event even without the synthetic assistant turn', () => {
  const text = unifiedEvent({ utilization: 1, resetsAt: 1788206400 }, { utilization: 0.34, resetsAt: 1788724800 }, 'rejected');
  assert.equal(isRateLimitDeath(text), true);
});

test('isRateLimitDeath: false on an ordinary successful transcript', () => {
  const text = unifiedEvent({ utilization: 0.5, resetsAt: 1788206400 }, { utilization: 0.2, resetsAt: 1788724800 }) + line({ type: 'result', subtype: 'success', is_error: false });
  assert.equal(isRateLimitDeath(text), false);
});

test('isRateLimitDeath: false when the death phrase appears only as ordinary prose, not the structured synthetic turn', () => {
  // e.g. this very issue's own triage/implement session, whose prompt/plan discusses
  // rate-limit deaths — must not be misclassified as its own transcript rate-limiting.
  const text = line({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'The dead session showed "You\'ve hit your session limit" in its transcript.' }] },
  });
  assert.equal(isRateLimitDeath(text), false);
});

test('classifyFailureReason: prefers a structured failureReason on the report row when present', () => {
  const row = { ref: 'o/r#1', status: 'failed', failureReason: 'rate-limited' };
  assert.equal(classifyFailureReason(row, 'irrelevant transcript text'), 'rate-limited');
});

test('classifyFailureReason: falls back to transcript parsing when the report row has no failureReason', () => {
  const row = { ref: 'o/r#1', status: 'failed' };
  assert.equal(classifyFailureReason(row, deathLine()), 'rate-limited');
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
