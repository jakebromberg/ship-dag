// stats.mjs — pure, dependency-free aggregation helpers shared by /ship-dag
// telemetry (scripts/telemetry.mjs) and the eval harness (eval/).
//
// No I/O, no globals, no clock — safe to import anywhere and unit-test under
// `node --test`. Empty-input conventions are chosen so report math reads
// naturally rather than producing NaN: mean/rate → 0, percentile → null.
// Run tests: node --test "skills/ship-dag/scripts/**/*.test.mjs"

/**
 * Arithmetic mean of a numeric list. Empty list → 0 (a reporting identity, so
 * "mean bounces over an empty wave" reads as 0 rather than NaN).
 * @param {number[]} xs
 * @returns {number}
 */
export function mean(xs) {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Fraction of xs for which pred(x) is truthy, in [0,1]. Empty list → 0.
 * @template T
 * @param {(x: T) => boolean} pred
 * @param {T[]} xs
 * @returns {number}
 */
export function rate(pred, xs) {
  if (!xs.length) return 0;
  let k = 0;
  for (const x of xs) if (pred(x)) k += 1;
  return k / xs.length;
}

/**
 * Group xs into a Map keyed by keyFn(x), preserving first-seen key order.
 * @template T, K
 * @param {(x: T) => K} keyFn
 * @param {T[]} xs
 * @returns {Map<K, T[]>}
 */
export function groupBy(keyFn, xs) {
  const m = new Map();
  for (const x of xs) {
    const k = keyFn(x);
    const bucket = m.get(k);
    if (bucket) bucket.push(x);
    else m.set(k, [x]);
  }
  return m;
}

/**
 * Linear-interpolated percentile p∈[0,100] of a numeric list. Empty → null.
 * p=0 → min, p=100 → max, p=50 → median. p is clamped to [0,100]. Does not
 * mutate the input.
 * @param {number} p
 * @param {number[]} xs
 * @returns {number|null}
 */
export function percentile(p, xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const rank = (Math.max(0, Math.min(100, p)) / 100) * (s.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (rank - lo);
}

/**
 * Count occurrences of keyFn(x) as a plain object {key: count}.
 * @template T
 * @param {(x: T) => string} keyFn
 * @param {T[]} xs
 * @returns {Record<string, number>}
 */
export function tabulate(keyFn, xs) {
  const out = {};
  for (const x of xs) {
    const k = keyFn(x);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

// mulberry32 — tiny deterministic PRNG so bootstrapCI is reproducible from a
// seed (the eval report must give the same CI on the same inputs). This module
// is imported by node scripts, NOT by workflow drivers, so a local PRNG here is
// fine — the Math.random ban is a workflow-script constraint.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile bootstrap CI for the MEAN of `values` (e.g. per-issue paired
 * Jaccard differences). Resamples with replacement `iterations` times using a
 * seeded PRNG, so the interval is reproducible. Empty input → null bounds.
 * @param {number[]} values
 * @param {{iterations?: number, alpha?: number, seed?: number}} [opts]
 * @returns {{mean: number, lo: number|null, hi: number|null, n: number, iterations: number}}
 */
export function bootstrapCI(values, { iterations = 2000, alpha = 0.05, seed = 1 } = {}) {
  const n = values.length;
  if (n === 0) return { mean: 0, lo: null, hi: null, n: 0, iterations };
  const rng = mulberry32(seed);
  const means = new Array(iterations);
  for (let it = 0; it < iterations; it += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += values[Math.floor(rng() * n)];
    means[it] = sum / n;
  }
  return {
    mean: mean(values),
    lo: percentile((alpha / 2) * 100, means),
    hi: percentile((1 - alpha / 2) * 100, means),
    n,
    iterations,
  };
}

/**
 * Exact (binomial) McNemar test for PAIRED binary outcomes — e.g. did variant A
 * vs variant B each catch the SAME seeded mutant. `pairs` is a list of
 * {a: boolean, b: boolean}. Only discordant pairs (one caught, the other missed)
 * carry signal; the two-sided p-value is the exact binomial tail at p=0.5 over
 * them (no normal approximation, so it's valid at small n). `better` names the
 * variant that caught more of the discordant pairs.
 * @param {{a: boolean, b: boolean}[]} pairs
 * @returns {{n:number, concordant:number, aOnly:number, bOnly:number, discordant:number, pValue:number, better:('a'|'b'|'tie')}}
 */
export function mcnemar(pairs) {
  let aOnly = 0; // A caught, B missed
  let bOnly = 0; // A missed, B caught
  let concordant = 0;
  for (const { a, b } of pairs) {
    if (a && !b) aOnly += 1;
    else if (!a && b) bOnly += 1;
    else concordant += 1;
  }
  const discordant = aOnly + bOnly;
  const k = Math.min(aOnly, bOnly);
  // Two-sided exact binomial tail: 2·Σ_{i=0}^{k} C(n,i)·0.5^n, clamped to 1.
  let pValue = 1;
  if (discordant > 0) {
    let term = Math.pow(0.5, discordant); // i=0 term: C(n,0)·0.5^n
    let cum = term;
    for (let i = 1; i <= k; i += 1) {
      term *= (discordant - i + 1) / i; // C(n,i) = C(n,i-1)·(n-i+1)/i
      cum += term;
    }
    pValue = Math.min(1, 2 * cum);
  }
  return {
    n: pairs.length,
    concordant,
    aOnly,
    bOnly,
    discordant,
    pValue,
    better: aOnly > bOnly ? 'a' : bOnly > aOnly ? 'b' : 'tie',
  };
}
