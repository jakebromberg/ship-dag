// run.mjs — locate a run for the status board: its dir, the family of dirs that
// hold its waves, each wave's display id, and the board's own files.
//
// Pure helpers over the filesystem, no CLI. The family, the sidecar match and the
// wave configs come from the shared readers in lib/ (`runFamilyStateDirs`, `configDirs`,
// `readSidecar`, `waveConfigs`) so the board and ingest agree on which dirs and which
// waves are a run's.

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { defaultBaseDir } from '../rate-limit-preflight.mjs';
import { readRecords, telemetryPath } from '../telemetry.mjs';
import { formatRef } from '../lib/ref.mjs';
import { runFamily, runIdFromConfigName, sameRun } from '../lib/run-id.mjs';
import { SIDECAR_NAME, readSidecar, waveConfigs, waveContextMatches } from '../lib/wave-sidecar.mjs';
import { configDirs, runFamilyStateDirs } from '../lib/wave-reports.mjs';

/**
 * The run's id and dir. `stateDir` names the dir (its basename is the run id); `runId` is looked up under
 * `defaultBaseDir(env)`. `$SHIP_DAG_RUN_ID` is read only when `envFallback` is set, so `init` (which does not
 * set it) can never write into a stale exported run.
 * @param {{stateDir?: string, runId?: string, env?: object, envFallback?: boolean}} opts
 * @returns {{runId: string, runDir: string}}
 * @throws when no run is named
 */
export function resolveRun({ stateDir, runId, env = process.env, envFallback = false } = {}) {
  if (stateDir) return { runId: basename(stateDir), runDir: stateDir };
  const id = runId || (envFallback ? env.SHIP_DAG_RUN_ID : undefined);
  if (!id) throw new Error('no run named: pass --state-dir or --run-id');
  return { runId: id, runDir: join(defaultBaseDir(env), id) };
}

/** Whether `dir` is the run's base dir: the family member whose name, without its `ship-dag-` prefix and in any case, is `runFamily(runId)`. */
const isBaseDir = (dir, runId) => runIdFromConfigName(basename(dir))?.toLowerCase() === runFamily(runId);

/**
 * The dir the board's files (`dag.json`, `board.json`, `board-notes.json`, `board.html`) live in: the run family's
 * existing base dir, however the run was named (`--state-dir` a `-b` sibling, `--run-id` spelled `ship-dag-<run>`),
 * else the named dir, which `init` creates for a new run.
 * @param {{runId: string, runDir: string}} run
 * @param {{warn?: (m: string) => void, dirs?: string[]}} [opts]  `dirs`: the family, already listed (`runFamilyStateDirs`)
 * @returns {string}
 */
export function runBaseDir({ runId, runDir }, { warn, dirs = runFamilyStateDirs(runDir, { runId, warn }) } = {}) {
  return dirs.find((dir) => isBaseDir(dir, runId) && existsSync(dir)) ?? runDir;
}

/** Wave ids are strings; every letter after the number is kept (`14b`, `37aa`). Captures the label of the plugin's `WAVE_DIR_RE`. */
const DIR_SUFFIX = /-w(\d+[a-z]*)$/i;
const FILE_ID = /^config[-.]?(?:wave|w)?(\d+[a-z]*)\.json$/i;

/**
 * Every wave of the run's family, oldest config first (by modification time, then path), as
 * `{id, dir, configFile, config, refs, mtimeMs}`. A wave is a `config*.json` with a `configDir` string and an
 * `issues` array, in a family dir or its older layout's `state/` (`configDirs`). The id is the first that applies:
 * the sidecar's wave number (when an entry's refs equal the config's; `wave: null` is absent), a `-w<id>` dir
 * suffix, the number in the config's filename, `1` for the run's base dir (the family member whose name, without
 * its `ship-dag-` prefix and in any case, is the run's `runFamily`, however `runId` is spelled), `1` for the first
 * wave when none came before it (a family with no base dir), else the previous wave's id plus `′`.
 * @param {{runId: string, runDir: string}} run
 * @param {{warn?: (m: string) => void, dirs?: string[]}} [opts]  `dirs`: the family, already listed (`runFamilyStateDirs`)
 */
export function runWaves({ runId, runDir }, { warn, dirs = runFamilyStateDirs(runDir, { runId, warn }) } = {}) {
  const found = dirs.flatMap((dir) => {
    const sidecar = readSidecar(join(dir, SIDECAR_NAME), { warn });
    const waves = configDirs(dir).flatMap(waveConfigs).filter((w) => typeof w.config.configDir === 'string')
      .map((w) => {
        const refs = w.config.issues.map((i) => formatRef(i?.repo, i?.number));
        return { ...w, dir, refs, refSet: [...new Set(refs)].sort().join(' ') };
      });
    return waves.map(({ refSet, ...w }) => {
      // An entry emitted at or after the next config of the same ref set is that config's, not this one's.
      // emit-config stamps an entry just after writing its config, but at millisecond precision, so compare
      // against the next config's mtime truncated to the millisecond too.
      const next = Math.floor(Math.min(...waves.filter((o) => o.refSet === refSet && o.mtimeMs > w.mtimeMs).map((o) => o.mtimeMs)));
      return { ...w, sidecarWave: sidecar.findLast((e) => waveContextMatches(e, w.refs) && !(Date.parse(e.emittedAt) >= next))?.wave };
    });
  });
  found.sort((a, b) => a.mtimeMs - b.mtimeMs || a.configFile.localeCompare(b.configFile));
  let prev = null;
  return found.map(({ sidecarWave, ...w }) => {
    const id = (sidecarWave != null ? String(sidecarWave) : null)
      ?? basename(w.dir).match(DIR_SUFFIX)?.[1]
      ?? basename(w.configFile).match(FILE_ID)?.[1]
      ?? (isBaseDir(w.dir, runId) || prev === null ? '1' : `${prev}′`);
    prev = id;
    return { ...w, id };
  });
}

/** Parse `path` as JSON: null when absent, a thrown error naming the path when it cannot be read or is malformed. */
export function readJson(path) {
  let text;
  try { text = readFileSync(path, 'utf-8'); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${path}: cannot read (${err.code ?? err.message})`);
  }
  try { return JSON.parse(text); } catch (err) { throw new Error(`${path}: not valid JSON (${err.message})`); }
}

/** `<runDir>/board-notes.json` parsed, or null when absent. */
export const readNotes = (runDir) => readJson(join(runDir, 'board-notes.json'));

/** `board.json` in `runDir` (or `opts.path`, from `--board-config`) parsed, or null when absent. */
export const readBoard = (runDir, { path } = {}) => readJson(path ?? join(runDir, 'board.json'));

/**
 * The retro records filed for the run's family, from the telemetry log at `path`: `sameRun` folds a
 * `ship-dag-`-prefixed or retry id into the run, other kinds are skipped, and a record filed twice (identical but for
 * the `ts` each append stamps) counts once.
 */
export function readRetros(runId, { path = telemetryPath() } = {}) {
  const seen = new Set();
  return readRecords(path).filter((r) => {
    if (r?.kind !== 'retro' || !sameRun(r.runId, runId)) return false;
    const { ts, ...rest } = r;
    const key = JSON.stringify(rest);
    return !seen.has(key) && seen.add(key);
  });
}
