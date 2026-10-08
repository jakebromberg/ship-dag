// wave-sidecar.mjs — the append-only `ship-dag-wave.json` emit-config drops in
// the run's state dir. One entry per emitted wave records what the engine's own
// artifacts cannot: the parsed `blockOn`, the `tuningVersion`, and per-issue
// routing, so a wave re-ingested later is judged under the policy it ran with.
// Point-A defers are not recorded here (SKILL.md step 3d writes those).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseBlockOn } from '../review-gate.mjs';
import { runIdFromConfigName } from './run-id.mjs';
import { load as loadTuning } from './tuning.mjs';

export const SIDECAR_NAME = 'ship-dag-wave.json';

/** The `owner/repo#N` ref of a spec issue. */
const refOf = (issue, spec) => `${issue.repo || spec.repo}#${issue.number}`;

/**
 * Build one sidecar entry from a ready-wave spec.
 * @param {object} spec the ready-wave spec emit-config was handed; `blockOn` may be
 *   the `--block-on` comma string or an array of categories (workflow.js's form)
 * @param {{now?: () => string, tuning?: {version: unknown}}} [opts] `tuning` is the
 *   object the config was built from; defaults to reading the shipped tuning.json
 */
export function waveSidecar(spec, { now = () => new Date().toISOString(), tuning = loadTuning() } = {}) {
  const { blockOn } = spec;
  return {
    runId: spec.runId || runIdFromConfigName(spec.name),
    wave: spec.wave ?? null,
    tuningVersion: tuning.version,
    blockOn: parseBlockOn(Array.isArray(blockOn) ? blockOn.join(',') : blockOn),
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
 * Append `entry` to `dir`'s sidecar atomically (temp file + rename), creating `dir`
 * when it does not exist yet. Never throws: a failure warns and returns false, an
 * unreadable existing file is left as-is, and a relative or missing `dir` (a spec
 * with no absolute `stateDir`) is refused rather than resolved against the cwd.
 */
export function appendWave(dir, entry, { warn = (m) => console.error(m) } = {}) {
  if (typeof dir !== 'string' || !isAbsolute(dir)) {
    warn(`emit-config: WARNING — not writing the wave sidecar: the state dir ${JSON.stringify(dir)} is not an absolute path`);
    return false;
  }
  const path = join(dir, SIDECAR_NAME);
  try {
    mkdirSync(dir, { recursive: true });
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
