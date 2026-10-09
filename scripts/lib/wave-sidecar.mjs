// wave-sidecar.mjs — the append-only `ship-dag-wave.jsonl` emit-config drops in
// the run's state dir. One line per emitted wave records what the engine's own
// artifacts cannot: the parsed `blockOn`, the `tuningVersion`, and per-issue
// routing, so a wave re-ingested later is judged under the policy it ran with.
// Point-A defers are not recorded here (SKILL.md step 3d writes those).
//
// Per-issue fields: `ref` (owner/repo#N, the repo as the config resolved it),
// `complexity`, `reach`, `decisions` (from the spec), and what the config assigned:
// `effort` (the issue's own, else the tuning map's for its complexity, else the
// config's defaultEffort), `effortSource` ('override' | 'tuning' | 'default' — which
// of those it was), and `model` (the issue's own, else the config's defaultModel).
//
// JSONL, like runs.jsonl: each wave is one `appendFileSync`, so nothing already
// written is ever rewritten, overlapping emits can't drop an entry, and a corrupt
// line costs only itself.
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseBlockOn } from '../review-gate.mjs';
import { runIdFromConfigName } from './run-id.mjs';
import { load as loadTuning } from './tuning.mjs';

export const SIDECAR_NAME = 'ship-dag-wave.jsonl';

/**
 * A spec's `blockOn` parsed like `--block-on`: the comma string or an array of
 * categories (workflow.js's form); absent means the default list. Throws on any
 * other type or an unknown category, so emit-config can refuse the spec up front.
 */
export function specBlockOn(blockOn) {
  if (blockOn != null && typeof blockOn !== 'string' && !Array.isArray(blockOn)) {
    throw new Error(`spec blockOn must be a comma string or an array, got ${JSON.stringify(blockOn)}`);
  }
  return parseBlockOn(Array.isArray(blockOn) ? blockOn.join(',') : blockOn);
}

/**
 * Build one sidecar entry from a ready-wave spec.
 * @param {object} spec the ready-wave spec emit-config was handed; `blockOn` may be
 *   the `--block-on` comma string or an array of categories (workflow.js's form)
 * @param {{config: object, now?: () => string, tuning?: {version: unknown}}} opts
 *   `config` is what buildConfig returned for `spec`; `tuning` is the object it was
 *   built from, and defaults to reading the shipped tuning.json
 */
export function waveSidecar(spec, { config, now = () => new Date().toISOString(), tuning = loadTuning() } = {}) {
  if (!config || !Array.isArray(config.issues)) throw new Error('waveSidecar needs the config buildConfig returned for this spec');
  return {
    runId: spec.runId || runIdFromConfigName(spec.name),
    wave: spec.wave ?? null,
    tuningVersion: tuning.version,
    blockOn: specBlockOn(spec.blockOn),
    emittedAt: now(),
    // buildConfig maps spec issues to config issues one-to-one and in order, so pair
    // them by position: a number alone is ambiguous when two repos share it.
    issues: spec.issues.map((issue, index) => {
      const built = config.issues[index];
      return {
        ref: `${built.repo}#${built.number}`,
        complexity: issue.complexity ?? null,
        effort: built.effort ?? config.defaultEffort,
        effortSource: issue.effort ? 'override' : built.effort ? 'tuning' : 'default',
        model: built.model ?? config.defaultModel,
        reach: issue.reach ?? null,
        decisions: issue.decisions ?? [],
      };
    }),
  };
}

/** True when the entry's issue refs equal `refs` as a set. */
export function waveContextMatches(entry, refs) {
  const have = new Set((entry?.issues ?? []).map((i) => i.ref));
  const want = new Set(refs);
  return have.size === want.size && [...want].every((r) => have.has(r));
}

/**
 * The entries in the sidecar at `path`, oldest first ([] when absent). A line that
 * doesn't parse to an object is skipped and counted in one warning, so one bad line
 * never hides the waves around it.
 */
export function readSidecar(path, { warn = (m) => console.error(m) } = {}) {
  if (!existsSync(path)) return [];
  const entries = [];
  let bad = 0;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { bad += 1; continue; }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) entries.push(entry);
    else bad += 1;
  }
  if (bad) warn(`wave sidecar ${path}: skipped ${bad} unreadable line${bad === 1 ? '' : 's'}`);
  return entries;
}

/** The entry in `dir`'s sidecar whose ref set equals `refs`, or null (the latest, if re-emitted). */
export function findWaveContext(dir, refs) {
  return readSidecar(join(dir, SIDECAR_NAME)).findLast((e) => waveContextMatches(e, refs)) ?? null;
}

/**
 * Append `entry` to `dir`'s sidecar as one line, creating `dir` when it does not
 * exist yet. Never throws: a failure warns and returns false, and a relative or
 * missing `dir` (a spec with no absolute `stateDir`) is refused rather than
 * resolved against the cwd.
 */
export function appendWave(dir, entry, { warn = (m) => console.error(m) } = {}) {
  if (typeof dir !== 'string' || !isAbsolute(dir)) {
    warn(`emit-config: WARNING — not writing the wave sidecar: the state dir ${JSON.stringify(dir)} is not an absolute path`);
    return false;
  }
  const path = join(dir, SIDECAR_NAME);
  try {
    mkdirSync(dir, { recursive: true });
    // A torn last line (no trailing newline) would swallow this entry into it, so
    // start on a fresh line: the torn line then costs only itself.
    const lead = endsMidLine(path) ? '\n' : '';
    appendFileSync(path, `${lead}${JSON.stringify(entry)}\n`);
    return true;
  } catch (err) {
    warn(`emit-config: WARNING — could not write the wave sidecar in ${dir}: ${err.message}`);
    return false;
  }
}

/** Whether the file at `path` exists, is non-empty, and doesn't end in a newline. */
function endsMidLine(path) {
  if (!existsSync(path)) return false;
  const fd = openSync(path, 'r');
  try {
    const { size } = fstatSync(fd);
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}
