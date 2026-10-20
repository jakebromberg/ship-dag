// ref.mjs — the one definition of `owner/repo#N` parsing and a ref's file stem. scripts/lib/ref.mjs and
// scripts/lib/failure.mjs re-export these. No Node imports: an installed plugin reaches nothing outside its folder.

/** A composite issue ref: group 1 is `owner/repo` (one slash, no whitespace), group 2 the number. */
export const REF_RE = /^([^/#\s]+\/[^/#\s]+)#(\d+)$/;

/** `{repo, number}` for an `owner/repo#N` string, or null for anything else (a non-string, a missing owner, a second slash, whitespace, a `#` in the repo, trailing text). */
export function parseRef(ref) {
  const m = typeof ref === 'string' ? REF_RE.exec(ref) : null;
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/**
 * The file stem the engine writes for a composite ref (`owner/repo#N`; status, log, metadata, failure digests).
 * Mirrors claude-orchestrator's `encodeRefForFilename` **exactly** — only `%`, `/` and `#` are escaped.
 *
 * Deliberately not `encodeURIComponent`: the two agree on every ref made of
 * legal GitHub owner/repo characters, which is precisely what would keep a
 * mismatch hidden until some ref contained a character they disagree about and
 * a lookup silently found no file.
 * @param {string} ref  composite issue ref, `owner/repo#N`
 */
export function artifactStem(ref) {
  return String(ref).replace(/%/g, '%25').replace(/\//g, '%2F').replace(/#/g, '%23');
}
