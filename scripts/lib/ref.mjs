// ref.mjs — the one place the telemetry modules parse and build `owner/repo#N` refs, say what a PR
// number is, and fold repos for comparison.

/** A composite issue ref: group 1 is `owner/repo` (one slash, no whitespace), group 2 the number. */
export const REF_RE = /^([^/#\s]+\/[^/#\s]+)#(\d+)$/;

/** `{repo, number}` for an `owner/repo#N` string, or null for anything else (a non-string, a missing owner, a second slash, whitespace, a `#` in the repo, trailing text). */
export function parseRef(ref) {
  const m = typeof ref === 'string' ? REF_RE.exec(ref) : null;
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/** The `owner/repo#N` ref for `repo` and `number`, as the engine writes it. */
export const formatRef = (repo, number) => `${repo}#${number}`;

/** Whether `n` is a PR number: a positive integer. `1.5`, `'7'`, `0`, `-1` and null are not. */
export const isPr = (n) => Number.isInteger(n) && n > 0;

/** A repo or ref as a Map, Set or cache-dir key: case-folded, as GitHub compares names. */
export const refKey = (s) => String(s).toLowerCase();

/**
 * Whether two repos (`owner/repo`) are the same one: GitHub names compare case-insensitively. Records
 * from different writers (sameRecord, ingest-wave's cost dedupe) compare through it, and escapes keys
 * by `refKey`. A report's lookups into its own rows and routing stay exact: a record finds its row by
 * the ref as written, and waveContextMatches pairs a report only with an entry or config whose refs
 * are the report's as written.
 */
export const sameRepo = (a, b) => refKey(a) === refKey(b);
