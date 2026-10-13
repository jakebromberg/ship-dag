// Tests for the shared stats helpers. Run: node --test "skills/ship-dag/scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mean, rate, groupBy, percentile, tabulate, bootstrapCI, mcnemar, wilson } from './stats.mjs';

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('mean: empty → 0, single, multi', () => {
  assert.equal(mean([]), 0);
  assert.equal(mean([5]), 5);
  approx(mean([1, 2, 3, 4]), 2.5);
});

test('rate: empty → 0, all / none / some', () => {
  const even = (x) => x % 2 === 0;
  assert.equal(rate(even, []), 0);
  assert.equal(rate(even, [2, 4]), 1);
  assert.equal(rate(even, [1, 3]), 0);
  approx(rate(even, [1, 2, 3, 4]), 0.5);
});

test('groupBy: buckets by key, preserves first-seen order', () => {
  const g = groupBy((x) => x.t, [{ t: 'a', n: 1 }, { t: 'b', n: 2 }, { t: 'a', n: 3 }]);
  assert.deepEqual([...g.keys()], ['a', 'b']);
  assert.deepEqual(g.get('a').map((x) => x.n), [1, 3]);
  assert.deepEqual(g.get('b').map((x) => x.n), [2]);
});

test('percentile: empty → null, ends, median, interpolation, ties', () => {
  assert.equal(percentile(50, []), null);
  assert.equal(percentile(50, [7]), 7);
  assert.equal(percentile(0, [1, 2, 3, 4]), 1);
  assert.equal(percentile(100, [1, 2, 3, 4]), 4);
  approx(percentile(50, [1, 2, 3, 4]), 2.5);
  assert.equal(percentile(50, [2, 2, 2]), 2);
});

test('percentile: does not mutate input', () => {
  const xs = [3, 1, 2];
  percentile(50, xs);
  assert.deepEqual(xs, [3, 1, 2]);
});

test('tabulate: counts by key, empty → {}', () => {
  assert.deepEqual(tabulate((x) => x.v, [{ v: 'a' }, { v: 'a' }, { v: 'b' }]), { a: 2, b: 1 });
  assert.deepEqual(tabulate((x) => x, []), {});
});

test('bootstrapCI: empty → null bounds, no throw', () => {
  const r = bootstrapCI([]);
  assert.equal(r.n, 0);
  assert.equal(r.lo, null);
  assert.equal(r.hi, null);
});

test('bootstrapCI: constant sample → CI collapses to the constant', () => {
  const r = bootstrapCI([0.2, 0.2, 0.2, 0.2], { iterations: 500, seed: 7 });
  approx(r.mean, 0.2);
  approx(r.lo, 0.2);
  approx(r.hi, 0.2);
});

test('bootstrapCI: deterministic for a fixed seed, and brackets the mean', () => {
  const xs = [0.1, 0.3, 0.5, 0.7, 0.9];
  const a = bootstrapCI(xs, { seed: 42, iterations: 1000 });
  const b = bootstrapCI(xs, { seed: 42, iterations: 1000 });
  assert.deepEqual(a, b); // reproducible
  assert.ok(a.lo <= a.mean && a.mean <= a.hi);
  approx(a.mean, 0.5);
});

test('mcnemar: all concordant → p=1, tie', () => {
  const r = mcnemar([{ a: true, b: true }, { a: false, b: false }]);
  assert.equal(r.discordant, 0);
  assert.equal(r.pValue, 1);
  assert.equal(r.better, 'tie');
});

test('mcnemar: A catches every discordant pair → A better, small p', () => {
  const pairs = Array.from({ length: 8 }, () => ({ a: true, b: false }));
  const r = mcnemar(pairs);
  assert.equal(r.aOnly, 8);
  assert.equal(r.bOnly, 0);
  assert.equal(r.better, 'a');
  // exact two-sided p = 2·0.5^8 = 1/128
  approx(r.pValue, 2 * Math.pow(0.5, 8));
});

test('mcnemar: exact tail matches a hand-computed 6-1 split', () => {
  const pairs = [
    ...Array.from({ length: 6 }, () => ({ a: true, b: false })),
    { a: false, b: true },
  ];
  const r = mcnemar(pairs);
  assert.equal(r.discordant, 7);
  // 2·(C(7,0)+C(7,1))·0.5^7 = 2·8/128 = 0.125
  approx(r.pValue, 0.125);
  assert.equal(r.better, 'a');
});

test('wilson: empty → the whole interval, zero events keep an upper bound, and the smallest n under 5% is 73', () => {
  assert.deepEqual(wilson(0, 0), { lo: 0, hi: 1 });
  const zero = wilson(0, 73);
  assert.equal(zero.lo, 0);
  approx(zero.hi, 1.96 ** 2 / (73 + 1.96 ** 2), 1e-12);
  assert.ok(zero.hi < 0.05 && wilson(0, 72).hi > 0.05);
  const all = wilson(10, 10);
  assert.equal(all.hi, 1);
  assert.ok(all.lo < 1 && all.lo > 0.7);
});

test('wilson: a known interval (7 of 20 at 95%) and a wider z widens it', () => {
  const { lo, hi } = wilson(7, 20);
  approx(lo, 0.1812, 1e-3);
  approx(hi, 0.5671, 1e-3);
  assert.ok(wilson(7, 20, 2.576).lo < lo);
});
