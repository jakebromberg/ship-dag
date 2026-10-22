// wave-reports.mjs — the one reader of a state dir's wave reports (`<stateDir>/state/reports/*.json`),
// of the routing each report ran under, and of which dirs hold a run family's waves. ingest-wave, the
// escapes proxy, audit, the digest writer and diagnose-failure share it, so a rule about which routing a report gets (or whether it gets
// any) lands in one place.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseRef } from './ref.mjs';
import { sameRun } from './run-id.mjs';
import { carriedOver } from './wave-records.mjs';
import { entryFromConfig, findWaveConfig, findWaveContext } from './wave-sidecar.mjs';

/**
 * The report at `path`, parsed, as `{path, id (file stem), report, startedAt (epoch ms)}`. One that
 * does not parse or has no `issues[]` comes back with an `error` (the reason, with `path`) and no
 * `report`. One with a row that has no `owner/repo#N` ref (checked first), or no parseable `startedAt`,
 * comes back with its `report` and an `error`, so a caller can check its rows first; its `startedAt`
 * is there only when it parses, so a refused report's start still bounds an earlier wave's window.
 * @param {string} path
 * @returns {{path: string, id: string, report?: object, startedAt?: number, error?: string}}
 */
export function readWaveReport(path) {
  const out = { path, id: basename(path, '.json') };
  let report;
  try { report = JSON.parse(readFileSync(path, 'utf8')); } catch (err) { return { ...out, error: `${path}: cannot read the report: ${err.message}` }; }
  if (!Array.isArray(report?.issues)) return { ...out, error: `${path}: the report has no issues array` };
  const startedAt = typeof report.startedAt === 'string' ? Date.parse(report.startedAt) : NaN;
  const read = Number.isNaN(startedAt) ? { ...out, report } : { ...out, report, startedAt };
  const bad = report.issues.findIndex((r) => !parseRef(r?.ref)); // findIndex: a null row is falsy, so find would miss it
  if (bad !== -1) return { ...read, error: `${path}: a row has no owner/repo#N ref: ${JSON.stringify(report.issues[bad])}` };
  if (Number.isNaN(startedAt)) return { ...read, error: `${path}: the report has no parseable startedAt: ${JSON.stringify(report.startedAt)}` };
  return read;
}

/**
 * Every `*.json` directly under `reportsDir`, each read once by `readWaveReport`; one with an
 * `error` is warned about, for a caller to refuse or skip. A missing dir reads as no reports.
 * @param {string} reportsDir
 * @param {{warn?: (m: string) => void}} [opts]
 * @returns {ReturnType<typeof readWaveReport>[]}
 */
export function readReportsDir(reportsDir, { warn = (m) => console.error(m) } = {}) {
  let names;
  try { names = readdirSync(reportsDir).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
  return names.map((name) => {
    const read = readWaveReport(join(reportsDir, name));
    if (read.error) warn(read.error);
    return read;
  });
}

/**
 * Every `*.json` under `<stateDir>/state/reports/`, as `readReportsDir` reads them.
 * @param {string} stateDir
 * @param {{warn?: (m: string) => void}} [opts]
 * @returns {ReturnType<typeof readWaveReport>[]}
 */
export const readWaveReports = (stateDir, opts) => readReportsDir(join(stateDir, 'state', 'reports'), opts);

/**
 * The parsed reports of `reads` (`readWaveReports`' reads) that started before `startedAt`: what `carriedOver`
 * compares a row to. A report with no parseable `startedAt`, or none at all, is no earlier report. Each carries its id
 * (the file stem) as `reportId`, which a record of its rows is stamped with.
 * @param {ReturnType<typeof readWaveReport>[]} reads
 * @param {number} startedAt epoch ms
 * @returns {object[]}
 */
export const earlierReports = (reads, startedAt) => reads.filter((r) => r.report && Number.isFinite(r.startedAt) && r.startedAt < startedAt).map((r) => ({ ...r.report, reportId: r.id }));

/** The parsed reports of `reads` that started after `startedAt`, as `earlierReports` returns them: those whose markers can list a death of a report that started then. */
export const laterReports = (reads, startedAt) => reads.filter((r) => r.report && Number.isFinite(r.startedAt) && r.startedAt > startedAt).map((r) => ({ ...r.report, reportId: r.id }));

/**
 * The routing a report ran under, given as the `{report, startedAt}` `readWaveReport` returns for it:
 * the sidecar entry as of its start, else the entry `entryFromConfig` builds from the config that
 * matches its refs (in the first of `configDirs(stateDir)` that has one). `config` is that matching config
 * whichever `source` won, since only a config says which repos run no post-session check; `configFile`
 * is its path (`config.configFile`, null with no config), which tells a caller which config files some report matched.
 * @returns {{entry: object|null, config: object|null, configFile: string|null, source: 'sidecar'|'config'|null}}
 */
export function waveContextFor(stateDir, { report, startedAt: asOf }, { warn } = {}) {
  if (!Number.isFinite(asOf)) throw new TypeError(`waveContextFor: startedAt must be epoch ms, not ${JSON.stringify(asOf)}`);
  const refs = report.issues.map((r) => r?.ref);
  const sidecar = findWaveContext(stateDir, refs, { asOf, warn });
  let config = null;
  for (const dir of configDirs(stateDir)) if ((config = findWaveConfig(dir, refs, { asOf }))) break;
  const configFile = config?.configFile ?? null;
  if (sidecar) return { entry: sidecar, config, configFile, source: 'sidecar' };
  return config ? { entry: entryFromConfig(config), config, configFile, source: 'config' } : { entry: null, config, configFile, source: null };
}

/** Where a state dir keeps its wave configs, in the order they are searched: the dir, then the older layout's `state/`. */
export const configDirs = (stateDir) => [stateDir, join(stateDir, 'state')];

/**
 * The dirs under `baseDir` that hold waves of `runId`'s run family: every one whose name is `sameRun`
 * as `runId` (a `-b` retry dir folds in; `-board` does not), sorted, as paths. A missing `baseDir` reads as none.
 * @returns {string[]}
 * @throws the readdir error when `baseDir` exists but cannot be listed, rather than read as a run with no dirs
 */
export function runFamilyDirs(runId, baseDir) {
  let entries;
  try { entries = readdirSync(baseDir, { withFileTypes: true }); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  return entries.filter((e) => e.isDirectory() && sameRun(e.name, runId)).map((e) => join(baseDir, e.name)).sort();
}

/**
 * The dirs of `stateDir`'s run family, `stateDir` first: it and every `runFamilyDirs` sibling of it under its parent,
 * for `runId` (default: the run id the dir's name carries). The one scope rule of a run family: ingest, audit-side
 * readers, the digest writer and diagnose-failure all take their dirs from here. A dir is told apart by device and
 * inode, so a path spelled with a trailing slash, through a symlink or in another case on a case-insensitive file
 * system is the same dir as the listing's, and is kept once. A parent that cannot be listed leaves `stateDir` alone,
 * with a warning.
 * @param {string} stateDir
 * @param {{warn?: (m: string) => void, runId?: string}} [opts]
 * @returns {string[]}
 */
export function runFamilyStateDirs(stateDir, { warn = (m) => console.error(m), runId = basename(stateDir) } = {}) {
  let siblings = [];
  try {
    siblings = runFamilyDirs(runId, dirname(stateDir));
  } catch (err) {
    warn(`cannot list ${dirname(stateDir)} (${err.code ?? err.message}), so the run family's reports and review rounds are read from ${stateDir} alone`);
  }
  const seen = new Set();
  const key = (d) => { try { const { dev, ino } = statSync(d); return `${dev}:${ino}`; } catch { return d; } };
  return [stateDir, ...siblings].filter((d) => !seen.has(key(d)) && seen.add(key(d)));
}

/**
 * Every report of `stateDir`'s run family, as `readWaveReports` reads each of `runFamilyStateDirs(stateDir, opts)`.
 * @param {string} stateDir
 * @param {{warn?: (m: string) => void, runId?: string}} [opts]
 * @returns {ReturnType<typeof readWaveReport>[]}
 */
export function readRunFamilyReports(stateDir, opts) {
  return runFamilyStateDirs(stateDir, opts).flatMap((d) => readWaveReports(d, opts));
}

/**
 * The one reading of which report owns a row, over `reads` (a run family's reads, `readRunFamilyReports`'s):
 * every caller that asks "is this row its report's own event" or "which report owns this ref" asks it here.
 * A read counts when it has a parsed `report` and a finite `startedAt`, whatever its `error`: a report refused for a
 * malformed row still started when it says, and ingest and audit have always read it so; a read without either is
 * no report here. Returns `reads` (those that count, oldest `startedAt` first, a tie by id) and:
 * - `earlierOf(read)`: the reports that started before `read` (`earlierReports`), computed once per read;
 * - `laterOf(read)`: the reports that started after `read` (`laterReports`);
 * - `owns(read, row)`: whether `row` of `read` is its own event, not one it `carriedOver` from `earlierOf(read)`;
 * - `listing`: by read id, the refs each of `reads` (counted or not) lists as its own row, built once on first use;
 * - `ownerOf(ref)`: the latest of `reads` whose row for `ref` it `owns`, as `{...read, row}`, or null;
 * - `rowOf(id, ref)`: the row for `ref` in the read `id` (any of `reads`, counted or not), or null.
 * @param {ReturnType<typeof readWaveReport>[]} reads
 */
export function reportOwnership(reads) {
  const counted = reads.filter((r) => r.report && Number.isFinite(r.startedAt)).sort((x, y) => x.startedAt - y.startedAt || (x.id < y.id ? -1 : 1));
  const memo = new Map();
  const earlierOf = (read) => memo.get(read) ?? memo.set(read, earlierReports(counted, read.startedAt)).get(read);
  const laterOf = (read) => laterReports(counted, read.startedAt);
  const owns = (read, row) => !carriedOver(row, earlierOf(read));
  const ownerOf = (ref) => {
    const rowIn = (r) => r.report.issues.find((row) => row?.ref === ref);
    const owner = counted.findLast((r) => { const row = rowIn(r); return row && owns(r, row); });
    return owner ? { ...owner, row: rowIn(owner) } : null;
  };
  const byId = new Map(reads.map((r) => [r.id, r]));
  const rowOf = (id, ref) => byId.get(id)?.report?.issues?.find((row) => row?.ref === ref) ?? null;
  let listing;
  return {
    reads: counted, earlierOf, laterOf, owns, ownerOf, rowOf,
    get listing() { return (listing ??= new Map(reads.map((r) => [r.id, new Set((r.report?.issues ?? []).filter((row) => row && owns(r, row)).map((row) => row.ref))]))); },
  };
}
