// Tests for the price table. Run: node --test "skills/ship-dag/eval/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costUSD, OUTPUT_USD_PER_MTOK } from './prices.mjs';

test('costUSD: rate × tokens / 1e6', () => {
  assert.equal(costUSD('sonnet', 1_000_000), 15);
  assert.equal(costUSD('opus', 2_000_000), 50);
  assert.equal(costUSD('haiku', 0), 0);
});

test('costUSD: unknown model throws', () => {
  assert.throws(() => costUSD('gpt', 1000), /no price for model: gpt/);
});

test('costUSD: honors an injected table', () => {
  assert.equal(costUSD('x', 1_000_000, { x: 3 }), 3);
});

test('price table covers the three tiers', () => {
  for (const m of ['haiku', 'sonnet', 'opus']) assert.equal(typeof OUTPUT_USD_PER_MTOK[m], 'number');
});
