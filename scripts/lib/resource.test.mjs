// Tests for the resource-preflight decision: the threshold table's ship-dag column.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handoffLimit, resourceDecision } from './resource.mjs';

// level, waitedMinutes, waitMaxMinutes → action, reason, recommendedParallel (K = 3 throughout)
const TABLE = [
  ['normal', 0, 15, 'proceed', 'normal', 3],
  ['normal', 99, 15, 'proceed', 'normal', 3],
  ['warning', 0, 15, 'proceed', 'warning-engine-adapts', 3],
  ['unknown', 0, 15, 'proceed', 'no-signal', 3],
  ['critical', 0, 15, 'wait', 'critical-wait', 0],
  ['critical', 14, 15, 'wait', 'critical-wait', 0],
  ['critical', 14.9, 15, 'wait', 'critical-wait', 0],
  ['critical', 15, 15, 'hitl', 'critical-hitl', 0],
  ['critical', 40, 15, 'hitl', 'critical-hitl', 0],
  ['critical', 5, 5, 'hitl', 'critical-hitl', 0],
];

for (const [level, waitedMinutes, waitMaxMinutes, action, reason, recommendedParallel] of TABLE) {
  test(`resourceDecision: ${level}, waited ${waitedMinutes} of ${waitMaxMinutes} → ${reason}`, () => {
    assert.deepEqual(resourceDecision({ level, parallel: 3, waitedMinutes, waitMaxMinutes }), { action, reason, recommendedParallel });
  });
}

test('resourceDecision: defaults to no wait so far, a 15-minute cap and K = 4', () => {
  assert.deepEqual(resourceDecision({ level: 'critical' }), { action: 'wait', reason: 'critical-wait', recommendedParallel: 0 });
  assert.equal(resourceDecision({ level: 'normal' }).recommendedParallel, 4);
  assert.equal(resourceDecision({ level: 'critical', waitedMinutes: 15 }).action, 'hitl');
});

test('resourceDecision: an unrecognised level never opens capacity — it reads as critical', () => {
  assert.equal(resourceDecision({ level: 'bogus', parallel: 2 }).reason, 'critical-wait');
});

// reason, capacity, live holders → PRs one hand-off invocation may hand over
const HANDOFF = [
  ['normal', 4, [], 4],
  ['normal', 4, ['a', 'b'], 2],
  ['warning-engine-adapts', 4, ['a', 'b', 'c', 'd'], 1],
  ['warning-engine-adapts', 2, ['a', 'b', 'c'], 1],
  ['lease-unavailable', null, [], 1],
  ['no-signal', 4, [], 1],
  ['no-signal', null, ['a'], 1],
  ['critical-wait', 4, [], 0],
  ['critical-hitl', 4, ['a'], 0],
];

for (const [reason, capacity, live, limit] of HANDOFF) {
  test(`handoffLimit: ${reason}, capacity ${capacity}, ${live.length} live → ${limit}`, () => {
    assert.equal(handoffLimit({ reason, capacity, live }), limit);
  });
}

test('handoffLimit: counts the holders array, never the array itself, and a missing live list as none', () => {
  assert.equal(handoffLimit({ reason: 'normal', capacity: 3, live: [{ pid: 1 }] }), 2);
  assert.equal(handoffLimit({ reason: 'normal', capacity: 3 }), 3);
});
