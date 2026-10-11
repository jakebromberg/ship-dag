// wave-reports.mjs — the one reader of a state dir's wave reports (`<stateDir>/state/reports/*.json`)
// and of the routing each report ran under. ingest-wave and the escapes proxy share it, so a rule
// about which routing a report gets (or whether it gets any) lands in one place.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { entryFromConfig, findWaveConfig, findWaveContext } from './wave-sidecar.mjs';

/**
 * The report at `path`, parsed, as `{path, id (file stem), report, startedAt (epoch ms)}`. One that
 * does not parse or has no `issues[]` comes back with an `error` (the reason, with `path`) and no
 * `report`; one with no parseable `startedAt` comes back with its `report` and an `error` in place of
 * `startedAt`, so a caller can check its rows first.
 * @param {string} path
 * @returns {{path: string, id: string, report?: object, startedAt?: number, error?: string}}
 */
export function readWaveReport(path) {
  const out = { path, id: basename(path, '.json') };
  let report;
  try { report = JSON.parse(readFileSync(path, 'utf8')); } catch (err) { return { ...out, error: `${path}: cannot read the report: ${err.message}` }; }
  if (!Array.isArray(report?.issues)) return { ...out, error: `${path}: the report has no issues array` };
  const startedAt = typeof report.startedAt === 'string' ? Date.parse(report.startedAt) : NaN;
  if (Number.isNaN(startedAt)) return { ...out, report, error: `${path}: the report has no parseable startedAt: ${JSON.stringify(report.startedAt)}` };
  return { ...out, report, startedAt };
}

/**
 * Every `*.json` under `<stateDir>/state/reports/`, each read once by `readWaveReport`; one with an
 * `error` is warned about, for a caller to refuse or skip. A missing dir reads as no reports.
 * @param {string} stateDir
 * @param {{warn?: (m: string) => void}} [opts]
 * @returns {ReturnType<typeof readWaveReport>[]}
 */
export function readWaveReports(stateDir, { warn = (m) => console.error(m) } = {}) {
  const dir = join(stateDir, 'state', 'reports');
  let names;
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
  return names.map((name) => {
    const read = readWaveReport(join(dir, name));
    if (read.error) warn(read.error);
    return read;
  });
}

/**
 * The routing a report ran under, given as the `{report, startedAt}` `readWaveReport` returns for it:
 * the sidecar entry as of its start, else the entry `entryFromConfig` builds from the config that
 * matches its refs (in `stateDir`, then the older `stateDir/state`). `config` is that matching config
 * whichever `source` won, since only a config says which repos run no post-session check.
 * @returns {{entry: object|null, config: object|null, source: 'sidecar'|'config'|null}}
 */
export function waveContextFor(stateDir, { report, startedAt: asOf }, { warn } = {}) {
  if (!Number.isFinite(asOf)) throw new TypeError(`waveContextFor: startedAt must be epoch ms, not ${JSON.stringify(asOf)}`);
  const refs = report.issues.map((r) => r?.ref);
  const sidecar = findWaveContext(stateDir, refs, { asOf, warn });
  const config = findWaveConfig(stateDir, refs, { asOf }) ?? findWaveConfig(join(stateDir, 'state'), refs, { asOf });
  if (sidecar) return { entry: sidecar, config, source: 'sidecar' };
  return config ? { entry: entryFromConfig(config), config, source: 'config' } : { entry: null, config, source: null };
}
