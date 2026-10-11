// wave-reports.mjs — the one reader of a state dir's wave reports (`<stateDir>/state/reports/*.json`)
// and of the routing each report ran under. ingest-wave and the escapes proxy share it, so a rule
// about which routing a report gets (or whether it gets any) lands in one place.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { entryFromConfig, findWaveConfig, findWaveContext } from './wave-sidecar.mjs';

/**
 * Every `*.json` under `<stateDir>/state/reports/`, parsed once, as `{path, id (file stem), report,
 * startedAt (epoch ms)}`. One that does not parse, has no `issues[]` or has no parseable `startedAt`
 * is warned about and returned with an `error` (the reason, with `path`) in place of `startedAt`, for
 * a caller to refuse or skip. A missing dir reads as no reports.
 * @param {string} stateDir
 * @param {{warn?: (m: string) => void}} [opts]
 * @returns {{path: string, id: string, report?: object, startedAt?: number, error?: string}[]}
 */
export function readWaveReports(stateDir, { warn = (m) => console.error(m) } = {}) {
  const dir = join(stateDir, 'state', 'reports');
  let names;
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
  return names.map((name) => {
    const path = join(dir, name);
    const out = { path, id: basename(name, '.json') };
    let report;
    try { report = JSON.parse(readFileSync(path, 'utf8')); } catch (err) { out.error = `${path}: cannot read the report: ${err.message}`; }
    if (!out.error && !Array.isArray(report?.issues)) out.error = `${path}: the report has no issues array`;
    const startedAt = typeof report?.startedAt === 'string' ? Date.parse(report.startedAt) : NaN;
    if (!out.error && Number.isNaN(startedAt)) out.error = `${path}: the report has no parseable startedAt: ${JSON.stringify(report.startedAt)}`;
    if (out.error) { warn(out.error); return out; }
    return { ...out, report, startedAt };
  });
}

/**
 * The routing `report` (one with a parseable `startedAt`, as `readWaveReports` returns it) ran under:
 * the sidecar entry as of its start, else the entry `entryFromConfig` builds from the config that
 * matches its refs (in `stateDir`, then the older `stateDir/state`). `config` is that matching config
 * whichever `source` won, since only a config says which repos run no post-session check.
 * @returns {{entry: object|null, config: object|null, source: 'sidecar'|'config'|null}}
 */
export function waveContextFor(stateDir, report, { warn } = {}) {
  const refs = report.issues.map((r) => r?.ref);
  const asOf = Date.parse(report.startedAt);
  const sidecar = findWaveContext(stateDir, refs, { asOf, warn });
  const config = findWaveConfig(stateDir, refs, { asOf }) ?? findWaveConfig(join(stateDir, 'state'), refs, { asOf });
  if (sidecar) return { entry: sidecar, config, source: 'sidecar' };
  return config ? { entry: entryFromConfig(config), config, source: 'config' } : { entry: null, config, source: null };
}
