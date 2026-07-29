// tier.mjs — map a PR's shape to the ship-dag complexity tier used to stratify
// the eval corpus and to pick implement effort. Pure and dependency-free.
//
// The tier mirrors the triage subagent's `mechanical | normal | complex` label,
// approximated from diff size + path/label signals (triage judges the issue
// text; here we only have the merged PR's stats, so size is a proxy).
// Run tests: node --test "skills/ship-dag/eval/**/*.test.mjs"

// A single touched path or label in these families forces `complex` regardless
// of size: migrations/schema/SQL, security/auth/crypto, and breaking changes are
// exactly the surfaces the matrix escalates for.
// Segment-anchored so a family stem doesn't match an unrelated word: `\bauth`
// alone would flag `authors/`, so auth matches only auth/authn/authz/authenticate/
// authorize. Other stems anchor on a leading boundary to avoid mid-word hits.
const COMPLEX_PATH = /\bmigrat|\bschema|\.sql$|\bsecurity|\bauth(?:[nz]?\b|enticat|oriz)|\bcrypto/i;
const COMPLEX_LABEL = /(?:security|migration|schema|breaking)/i;

/**
 * @param {{changedFiles?: number, additions?: number, files?: string[],
 *          labels?: Array<string|{name:string}>}} pr
 * @returns {'mechanical'|'normal'|'complex'}
 */
export function complexityTier(pr = {}) {
  const { changedFiles = 0, additions = 0, files = [], labels = [] } = pr || {};
  const pathSignal = files.some((f) => COMPLEX_PATH.test(f));
  const labelSignal = labels.some((l) => COMPLEX_LABEL.test(typeof l === 'string' ? l : l?.name || ''));
  // Complex is checked first: a one-line migration is complex, not mechanical.
  if (changedFiles >= 5 || additions >= 200 || pathSignal || labelSignal) return 'complex';
  if (changedFiles <= 1 && additions <= 10) return 'mechanical';
  return 'normal';
}
