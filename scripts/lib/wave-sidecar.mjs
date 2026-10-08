// wave-sidecar.mjs — the append-only `ship-dag-wave.json` emit-config drops in
// the run's state dir. One entry per emitted wave records what the engine's own
// artifacts cannot: the parsed `blockOn`, the `tuningVersion`, and per-issue
// routing, so a wave re-ingested later is judged under the policy it ran with.
// Point-A defers are not recorded here (SKILL.md step 3d writes those).
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBlockOn } from '../review-gate.mjs';
import { runIdFromConfigName } from './run-id.mjs';
import { load as loadTuning } from './tuning.mjs';

export const SIDECAR_NAME = 'ship-dag-wave.json';

/** The `owner/repo#N` ref of a spec issue. */
const refOf = (issue, spec) => `${issue.repo || spec.repo}#${issue.number}`;

/**
 * Build one sidecar entry from a ready-wave spec.
 * @param {object} spec the ready-wave spec emit-config was handed
 * @param {{now?: () => string}} [opts]
 */
export function waveSidecar(spec, { now = () => new Date().toISOString() } = {}) {
  return {
    runId: spec.runId || runIdFromConfigName(spec.name),
    wave: spec.wave ?? null,
    tuningVersion: loadTuning().version,
    blockOn: parseBlockOn(spec.blockOn),
    emittedAt: now(),
    issues: spec.issues.map((issue) => ({
      ref: refOf(issue, spec),
      complexity: issue.complexity ?? null,
      model: issue.model ?? null,
      reach: issue.reach ?? null,
      decisions: issue.decisions ?? [],
    })),
  };
}

/** True when the entry's issue refs equal `refs` as a set. */
export function waveContextMatches(entry, refs) {
  const have = new Set((entry?.issues ?? []).map((i) => i.ref));
  const want = new Set(refs);
  return have.size === want.size && [...want].every((r) => have.has(r));
}

/** The entries in the sidecar at `path` ([] when absent); throws on unreadable or non-array content. */
export function readSidecar(path) {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf-8'));
  if (!Array.isArray(parsed)) throw new Error('not a JSON array');
  return parsed;
}

/** The entry in `dir`'s sidecar whose ref set equals `refs`, or null (the latest, if re-emitted). */
export function findWaveContext(dir, refs) {
  return readSidecar(join(dir, SIDECAR_NAME)).findLast((e) => waveContextMatches(e, refs)) ?? null;
}

/**
 * Append `entry` to `dir`'s sidecar atomically (temp file + rename). Never throws:
 * a failure warns and returns false, and an unreadable existing file is left as-is.
 */
export function appendWave(dir, entry, { warn = (m) => console.error(m) } = {}) {
  const path = join(dir, SIDECAR_NAME);
  try {
    const entries = readSidecar(path);
    entries.push(entry);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`);
    renameSync(tmp, path);
    return true;
  } catch (err) {
    warn(`emit-config: WARNING — could not write the wave sidecar in ${dir}: ${err.message}`);
    return false;
  }
}
