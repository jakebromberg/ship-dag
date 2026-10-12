// ref.mjs — the one place that parses and builds `owner/repo#N` refs, says what a PR number is, and how repos compare.

/** A composite issue ref: group 1 is `owner/repo`, group 2 the number. */
export const REF_RE = /^([^/#]+\/[^#]+)#(\d+)$/;

/** `{repo, number}` for an `owner/repo#N` string, or null for anything else (a non-string, a missing owner, a `#` in the repo, trailing text). */
export function parseRef(ref) {
  const m = typeof ref === 'string' ? REF_RE.exec(ref) : null;
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/** The `owner/repo#N` ref for `repo` and `number`, as the engine writes it. */
export const formatRef = (repo, number) => `${repo}#${number}`;

/** Whether `n` is a PR number: a positive integer. `1.5`, `'7'`, `0`, `-1` and null are not. */
export const isPr = (n) => Number.isInteger(n) && n > 0;

/**
 * Whether two repos (`owner/repo`) are the same one: GitHub names compare case-insensitively. Records
 * from different writers (sameRecord, ingest-wave's cost dedupe) compare through it, and escapes keys
 * by the lowercased ref. A report's lookups into its own rows and routing stay exact: a record finds its
 * row by the ref as written, and waveContextMatches pairs a report only with an entry or config whose refs
 * are the report's as written.
 */
export const sameRepo = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
