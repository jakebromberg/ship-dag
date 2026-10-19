// run-id.mjs — verbatim copies of `canonicalRunId` and `runFamily` from scripts/lib/run-id.mjs, which an installed
// plugin cannot import. scripts/eta/parity.test.mjs holds them equal to the originals.

/**
 * Fold a runId to the form its spellings share, for *matching only*: lowercase,
 * no `ship-dag-` prefix, no per-wave suffix (`-w2`, `-w1b`, `-r2`, `-resume`).
 * @param {string|null|undefined} runId
 * @returns {string|null}
 */
export function canonicalRunId(runId) {
  if (typeof runId !== 'string' || !runId.trim()) return null;
  let out = runId.trim().toLowerCase();
  while (out.startsWith('ship-dag-')) out = out.slice('ship-dag-'.length);
  let prev;
  do {
    prev = out;
    out = out.replace(/-(?:wave|resume|w|r)\d*[a-z]?$/, '');
  } while (out !== prev && out);
  return out || runId.trim().toLowerCase();
}

/**
 * The run family a run id names: `canonicalRunId` with a single-letter retry suffix (`-b`, `-c`) also folded away,
 * never a longer label. What `sameRun` compares; null for blank.
 * @param {string|null|undefined} runId
 * @returns {string|null}
 */
export function runFamily(runId) {
  const canon = canonicalRunId(runId);
  return canon && canonicalRunId(canon.replace(/-[a-z]$/, ''));
}
