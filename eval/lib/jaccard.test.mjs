// Tests for jaccard.mjs. Run: node --test "skills/ship-dag/eval/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jaccard, setStats } from './jaccard.mjs';

test('jaccard: identical sets → 1, disjoint → 0, partial → ratio', () => {
  assert.equal(jaccard(['a', 'b'], ['a', 'b']), 1);
  assert.equal(jaccard(['a'], ['b']), 0);
  assert.equal(jaccard(['a', 'b', 'c'], ['b', 'c', 'd']), 0.5); // inter 2 / union 4
});

test('jaccard: two empty sets are identical (1), one-sided empty → 0', () => {
  assert.equal(jaccard([], []), 1);
  assert.equal(jaccard(['a'], []), 0);
  assert.equal(jaccard([], ['a']), 0);
});

test('jaccard: dedupes and ignores blank/whitespace entries', () => {
  assert.equal(jaccard(['a', 'a', '  '], ['a']), 1);
});

test('setStats: precision/recall split with predOnly/goldOnly', () => {
  const s = setStats(['a', 'b', 'c'], ['b', 'c', 'd']);
  assert.equal(s.intersection, 2);
  assert.equal(s.precision, 2 / 3);
  assert.equal(s.recall, 2 / 3);
  assert.equal(s.jaccard, 0.5);
  assert.deepEqual(s.predOnly, ['a']);
  assert.deepEqual(s.goldOnly, ['d']);
});

test('setStats: empty prediction against non-empty gold → precision 1, recall 0', () => {
  const s = setStats([], ['x', 'y']);
  assert.equal(s.precision, 1);
  assert.equal(s.recall, 0);
  assert.equal(s.jaccard, 0);
  assert.deepEqual(s.goldOnly, ['x', 'y']);
});

test('setStats: both empty → all vacuously 1', () => {
  const s = setStats([], []);
  assert.equal(s.precision, 1);
  assert.equal(s.recall, 1);
  assert.equal(s.jaccard, 1);
});
