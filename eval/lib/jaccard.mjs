// jaccard.mjs — file-set overlap metrics for the implement-correctness track.
//
// The implement track scores a variant by how closely the file set it TOUCHED
// matches the file set the known-good merge touched. Jaccard is the headline
// (symmetric overlap); precision/recall split it into over-editing vs
// under-editing so a low score can be attributed to a cause. Pure + dependency-
// free — safe to unit-test under `node --test`.
// Run tests: node --test "skills/ship-dag/eval/**/*.test.mjs"

/** Coerce a list to a Set of trimmed, non-empty strings (dedupes, drops noise). */
function toSet(xs) {
  const s = new Set();
  for (const x of xs || []) {
    const t = String(x).trim();
    if (t) s.add(t);
  }
  return s;
}

/**
 * Jaccard index |A∩B| / |A∪B| of two file-path lists, in [0,1]. Two empty sets
 * are defined as identical (1) — nothing needed changing, nothing changed; one
 * empty and one non-empty → 0.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
export function jaccard(a, b) {
  const A = toSet(a);
  const B = toSet(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * Full overlap breakdown of a predicted file set against the gold set.
 * `precision` = fraction of predicted files that were in gold (guards against
 * over-editing); `recall` = fraction of gold files covered (guards against
 * under-editing). Empty denominators use the vacuous-truth convention (1), so an
 * empty prediction against a non-empty gold reads as precision 1 / recall 0.
 * @param {string[]} pred  files the variant touched
 * @param {string[]} gold  files the known-good merge touched
 * @returns {{jaccard:number, precision:number, recall:number, intersection:number, predOnly:string[], goldOnly:string[]}}
 */
export function setStats(pred, gold) {
  const P = toSet(pred);
  const G = toSet(gold);
  let inter = 0;
  for (const x of P) if (G.has(x)) inter += 1;
  return {
    jaccard: jaccard([...P], [...G]),
    precision: P.size ? inter / P.size : 1,
    recall: G.size ? inter / G.size : 1,
    intersection: inter,
    predOnly: [...P].filter((x) => !G.has(x)).sort(),
    goldOnly: [...G].filter((x) => !P.has(x)).sort(),
  };
}
