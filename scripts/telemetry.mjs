#!/usr/bin/env node
// telemetry.mjs — append-only run log for /ship-dag + a leading-indicator report.
//
// Every issue that reaches a terminal-for-this-wave state emits one JSON record
// (schema below). The log is append-only and lives OUTSIDE the ~/.claude repo
// (under the XDG state dir) so collected run data can never be accidentally
// committed. Pure aggregation math is imported from ./lib/stats.mjs; this file
// owns only validation, the file I/O, and the CLI.
//
// Record schema (see references/ for the authored version). Records carry a
// `kind` discriminator — "issue" (default; stamped when absent, so pre-existing
// logs stay valid) or "retro" (one run-scoped record per step-6.5 pass):
//   issue: { kind, ts, runId, reportId, repo, issue, complexity, complexitySource, triageStatus,
//            assignment, path, implStatus, ciStatus, reviewVerdict, failureReason, findings[],
//            bounces, hitl:{pointA,pointB}, finalState, pr, tokens, cost? }
// reportId (ingest-wave only) is the stem of the report a record was derived from: two PR-less
// failures (implStatus "error", the rows a retry re-runs) are one event only if their reportIds
// match, while any other record a later report re-lists unchanged stays one; hand-written records have none.
// complexitySource is "entry" (the wave's routing named the complexity) or "default" (it did
// not, and `complexity` is the "normal" ingest-wave assumed); absent on older records.
//   retro: { kind, ts, runId, wave, mergedPrs[], proposedRefactors, approvedRefactors,
//            declinedRefactors, proposedAdjustments, approvedAdjustments,
//            declinedAdjustments, filed[], adjusted[], declinedTitles[], tokens }
// cost is optional (null reads as absent): { implement: {costUsd, input, output, cacheRead, cacheCreate,
// sessions, sessionIds[]} }, summed from the ref's transcript over the sessions that wrote a result
// record and that no earlier record of the ref's run family (sameRun) lists. A session killed before
// writing one (a stall, a hard death) is not counted, so the figure can fall short of the real spend.
// A skipped row's record (implStatus null) never reached implement and carries no cost.
// implStatus / ciStatus / reviewVerdict are nullable: an issue that stops at
// HITL point A (needs-decision) never reaches implement, so it logs those null.
// failureReason is also nullable — set to "rate-limited" alongside
// implStatus: "error" when the wrapper (scripts/rate-limit-preflight.mjs /
// scripts/lib/rate-limit.mjs) identifies the five-hour window as the cause,
// so the eval harness can separate quota failures from model failures.
//
// Usage:
//   node telemetry.mjs append '<json>'      # append one record (validates + stamps ts)
//   node telemetry.mjs append @rec.json      # ...from a file
//   node telemetry.mjs append -              # ...from stdin
//   node telemetry.mjs report [--since ISO]  # print leading indicators (JSON + table)
//   node telemetry.mjs ingest-wave <stateDir>/state/reports/<id>.json [--outcomes <json|@file|->]
//                                            # append a wave's records, derived from its engine artifacts;
//                                            # exit 2: bad invocation or --outcomes, or a half-supplied
//                                            # wave; 3: malformed report, or no run id; 1: anything else
//   node telemetry.mjs escapes [--now ISO]  # escape rate of merged PRs (revert / bug follow-up within 30 days),
//                                            # by month and tuningVersion, with the strong-citation sub-rate
//                                            # (strong, strongRate) beside the headline; PRs from the log and the engine
//                                            # state dir's reports and sidecars; cache in $SHIP_DAG_ESCAPES_DIR
//   node telemetry.mjs audit <runId>         # name the waves of a run family (every dir under the engine base dir
//                                            # that sameRun the id) whose terminal rows have no record in the log,
//                                            # unreadable reports, and sidecar entries and configs no report matches
//   node telemetry.mjs tripwires [--escapes <file>] [--now ISO]
//                                            # evaluate references/tripwires.json against the current tuningVersion's
//                                            # records: tripped, holding, insufficient-data or pending-instrumentation,
//                                            # with past-due review dates; T-escapes reads a saved `escapes` run
//                                            # (--escapes), never GitHub, and T-coverage runs `audit` per run family
//   node telemetry.mjs run-id [--label L]    # print $SHIP_DAG_RUN_ID, else a freshly minted run id
//
// Path resolution: $SHIP_DAG_TELEMETRY, else $XDG_STATE_HOME/ship-dag/runs.jsonl,
// else ~/.local/state/ship-dag/runs.jsonl.

import { appendFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { mean, rate, groupBy } from './lib/stats.mjs';
import { isMain } from './lib/is-main.mjs';
import { mintRunId, runIdFromConfigName, sameRun } from './lib/run-id.mjs';
import { implementCost, isCount, isUsd } from './lib/transcript-cost.mjs';
import { deriveWaveRecords, rowCovered, TERMINAL, WaveRefusal } from './lib/wave-records.mjs';
import { isPr, parseRef, sameRepo } from './lib/ref.mjs';
import { configDirs, readWaveReport, readWaveReports, runFamilyDirs, waveContextFor } from './lib/wave-reports.mjs';
import { readSidecar, SIDECAR_NAME, waveConfigs } from './lib/wave-sidecar.mjs';
import { defaultBaseDir } from './rate-limit-preflight.mjs';
import { reviewRoundFiles } from './lib/review-rounds.mjs';
import { escapeReport, findEscapes, shipDagPrs } from './lib/escapes.mjs';
import { digestPathForRef, logPathForRef } from './diagnose-failure.mjs';
import { evaluateAll, loadTripwires, tripwireContext } from './lib/tripwires.mjs';
import { load as loadTuning } from './lib/tuning.mjs';

const COMPLEXITIES = new Set(['mechanical', 'normal', 'complex']);
const PATHS = new Set(['engine', 'inline', 'workflow']);
const FINAL_STATES = new Set(['merged', 'blocked-hitl', 'deferred', 'error']);
const IMPL_STATUSES = new Set(['pushed', 'blocked', 'error', null]);
// Nullable, carried alongside implStatus: "error" — distinguishes a rate-limit
// death (infra failure, wait-and-resume) from a model failure (HITL point B).
// Kept as its own field rather than growing IMPL_STATUSES so existing logs and
// the report subcommand stay valid without a coordinated schema bump.
const FAILURE_REASONS = new Set(['rate-limited', null]);
const REVIEW_VERDICTS = new Set(['clean', 'blocking', 'nits-only', null]);
const TRIAGE_STATUSES = new Set(['clear', 'needs-decision']);
const CI_STATUSES = new Set(['pass', 'fail', 'none', null]);
const COMPLEXITY_SOURCES = new Set(['entry', 'default']);
const TIERS = ['mechanical', 'normal', 'complex'];
const REQUIRED = ['runId', 'repo', 'issue', 'complexity', 'triageStatus', 'path', 'finalState'];
const KINDS = new Set(['issue', 'retro']);
// No `repo` here — a retro pass's merged surface may span repos; the composite
// refs in mergedPrs[] carry them. `wave` is a display label stamped from the
// main agent's wave counter, not an index any report logic depends on.
const REQUIRED_RETRO = ['runId', 'wave', 'mergedPrs'];
const RETRO_COUNTS = ['proposedRefactors', 'approvedRefactors', 'declinedRefactors', 'proposedAdjustments', 'approvedAdjustments', 'declinedAdjustments'];
const RETRO_LISTS = ['filed', 'adjusted', 'declinedTitles'];

/** Resolve the telemetry log path from the environment (see module header). */
export function telemetryPath(env = process.env) {
  if (env.SHIP_DAG_TELEMETRY) return env.SHIP_DAG_TELEMETRY;
  const base = env.XDG_STATE_HOME || `${env.HOME}/.local/state`;
  return `${base}/ship-dag/runs.jsonl`;
}

/**
 * Validate a raw record against the schema and return a normalized copy with
 * `ts` stamped (at append time) if absent and the nullable fields defaulted to
 * null. Throws on any bad enum or missing required field, so a malformed record
 * is never silently logged.
 * @param {object} rec
 * @param {() => string} now  injectable clock (ISO string) for tests
 */
export function normalizeRecord(rec, now = () => new Date().toISOString()) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    throw new Error('record must be an object');
  }
  const kind = rec.kind ?? 'issue';
  if (!KINDS.has(kind)) throw new Error(`bad kind: ${rec.kind}`);
  if (kind === 'retro') return normalizeRetroRecord(rec, now);
  // A retro-shaped record that forgot its discriminator would otherwise fall
  // through to the issue path and die on `missing required key: repo` — naming
  // the one field the retro schema deliberately excludes.
  if (rec.kind === undefined && (rec.mergedPrs !== undefined || rec.wave !== undefined)) {
    throw new Error('record has retro fields but is missing kind: "retro"');
  }
  for (const k of REQUIRED) {
    if (rec[k] === undefined || rec[k] === null) throw new Error(`missing required key: ${k}`);
  }
  if (!COMPLEXITIES.has(rec.complexity)) throw new Error(`bad complexity: ${rec.complexity}`);
  if (rec.complexitySource != null && !COMPLEXITY_SOURCES.has(rec.complexitySource)) throw new Error(`bad complexitySource: ${rec.complexitySource}`);
  // reportId decides whether two PR-less failures are one event, so only a report stem is let in.
  if (rec.reportId != null && (typeof rec.reportId !== 'string' || !rec.reportId)) throw new Error(`bad reportId: ${JSON.stringify(rec.reportId)}`);
  if (!PATHS.has(rec.path)) throw new Error(`bad path: ${rec.path}`);
  if (!FINAL_STATES.has(rec.finalState)) throw new Error(`bad finalState: ${rec.finalState}`);
  const implStatus = rec.implStatus ?? null;
  if (!IMPL_STATUSES.has(implStatus)) throw new Error(`bad implStatus: ${rec.implStatus}`);
  const reviewVerdict = rec.reviewVerdict ?? null;
  if (!REVIEW_VERDICTS.has(reviewVerdict)) throw new Error(`bad reviewVerdict: ${rec.reviewVerdict}`);
  if (!TRIAGE_STATUSES.has(rec.triageStatus)) throw new Error(`bad triageStatus: ${rec.triageStatus}`);
  const ciStatus = rec.ciStatus ?? null;
  if (!CI_STATUSES.has(ciStatus)) throw new Error(`bad ciStatus: ${rec.ciStatus}`);
  const failureReason = rec.failureReason ?? null;
  if (!FAILURE_REASONS.has(failureReason)) throw new Error(`bad failureReason: ${rec.failureReason}`);
  validateCost(rec.cost);
  return {
    ...rec,
    kind: 'issue',
    ts: rec.ts || now(),
    implStatus,
    ciStatus,
    reviewVerdict,
    failureReason,
    findings: rec.findings ?? [],
    bounces: rec.bounces ?? 0,
    hitl: { pointA: !!(rec.hitl && rec.hitl.pointA), pointB: !!(rec.hitl && rec.hitl.pointB) },
    tokens: rec.tokens ?? null,
  };
}

const COST_FIELDS = { costUsd: isUsd, input: isCount, output: isCount, cacheRead: isCount, cacheCreate: isCount, sessions: isCount };

/**
 * Throw on a `cost` that is not `{implement?: {costUsd, input, output, cacheRead, cacheCreate, sessions, sessionIds[]}}`.
 * A null `cost` reads as absent, like `tokens: null`. `sessionIds` lists each counted session once, so
 * a later ingest can skip them: it holds `sessions` distinct strings.
 */
function validateCost(cost) {
  if (cost == null) return;
  const bad = () => new Error(`bad cost: ${JSON.stringify(cost)}`);
  if (typeof cost !== 'object' || Array.isArray(cost)) throw bad();
  const impl = cost.implement;
  if (impl === undefined) return;
  const ids = impl?.sessionIds;
  const ok = impl && typeof impl === 'object' && Object.entries(COST_FIELDS).every(([k, valid]) => valid(impl[k]))
    && Array.isArray(ids) && ids.every((id) => typeof id === 'string') && new Set(ids).size === impl.sessions && ids.length === impl.sessions;
  if (!ok) throw bad();
}

/**
 * Validate and normalize a step-6.5 retrospective record (one per pass, run-
 * scoped). Deliberately a separate path from the issue-record normalization:
 * the issue coercions (the hitl forcing above, the nullable implStatus chain)
 * would silently mangle a retro record — hitl's coercion drops unknown keys —
 * so none of them are applied here.
 * @param {object} rec
 * @param {() => string} now  injectable clock (ISO string) for tests
 */
function normalizeRetroRecord(rec, now) {
  for (const k of REQUIRED_RETRO) {
    if (rec[k] === undefined || rec[k] === null) throw new Error(`missing required key: ${k}`);
  }
  if (!Array.isArray(rec.mergedPrs)) throw new Error('mergedPrs must be an array');
  const out = { ...rec, kind: 'retro', ts: rec.ts || now(), tokens: rec.tokens ?? null };
  for (const k of RETRO_COUNTS) {
    const v = rec[k] ?? 0;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${k} must be a number`);
    out[k] = v;
  }
  // declinedTitles makes the run ledger reconstructible after a compaction:
  // declined proposals are deliberately never written to GitHub, so the log
  // is their only durable home.
  for (const k of RETRO_LISTS) {
    const v = rec[k] ?? [];
    if (!Array.isArray(v)) throw new Error(`${k} must be an array`);
    out[k] = v;
  }
  return out;
}

/** Append one validated record as a JSON line; creates the state dir if needed. */
export function appendRecord(rec, { path = telemetryPath(), now } = {}) {
  const norm = normalizeRecord(rec, now);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(norm)}\n`);
  return norm;
}

/** Read all records from the log (missing file → []). Skips blank lines. */
export function readRecords(path = telemetryPath()) {
  if (!existsSync(path)) return [];
  const out = [];
  let skipped = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      skipped += 1; // tolerate a torn / hand-edited line rather than killing the whole report
    }
  }
  if (skipped) process.stderr.write(`telemetry: skipped ${skipped} malformed line(s) in ${path}\n`);
  return out;
}

/**
 * Compute leading indicators from a set of records. Returns integer counts
 * alongside each rate so callers/tests aren't at the mercy of float formatting.
 * "reached implement" = implStatus != null (point-A defers are excluded from
 * yield/bounce/review-catch and the triage-miss denominator — they're
 * needs-decision, not clear — but still count toward the record total and HITL).
 * A record with failureReason: "rate-limited" (an infra death, not a model
 * failure) is likewise excluded from yield/byComplexity/triage-miss/bounce/
 * review-catch — it still counts toward the record total and HITL, and is
 * tallied separately in `quotaFailures`.
 * kind:"retro" records are excluded from every per-issue indicator (they are
 * pass-scoped, not issue-scoped) and aggregated into their own `retro` section.
 */
export function report(records) {
  const issues = records.filter((r) => r.kind !== 'retro');
  const retros = records.filter((r) => r.kind === 'retro');
  // A failureReason: "rate-limited" record is an infra death (the wrapper's
  // wait/resume cycle killed the attempt), not a model-quality signal. Exclude
  // it from the model-quality population — first-pass yield (and its
  // byComplexity breakdown), triage-miss, bounce rate, review-catch — so a
  // quota outage never dilutes those; it's counted instead in quotaFailures.
  const quotaFailures = issues.filter((r) => r.failureReason === 'rate-limited');
  const modelIssues = issues.filter((r) => r.failureReason !== 'rate-limited');
  const reached = modelIssues.filter((r) => r.implStatus != null);
  const cleared = modelIssues.filter((r) => r.triageStatus === 'clear');
  const yieldOf = (rs) => {
    const pass = rs.filter((r) => r.finalState === 'merged' && (r.bounces ?? 0) === 0).length;
    return { reached: rs.length, pass, rate: rs.length ? pass / rs.length : 0 };
  };
  const byComplexity = {};
  const g = groupBy((r) => r.complexity, reached);
  for (const tier of TIERS) byComplexity[tier] = yieldOf(g.get(tier) || []);
  const miss = cleared.filter((r) => r.implStatus === 'blocked' || r.reviewVerdict === 'blocking').length;
  const blocking = reached.filter((r) => r.reviewVerdict === 'blocking').length;
  const hitlOf = (side) => ({
    n: issues.length,
    count: issues.filter((r) => r.hitl && r.hitl[side]).length,
    rate: rate((r) => r.hitl && r.hitl[side], issues),
  });
  const sum = (k) => retros.reduce((a, r) => a + (r[k] ?? 0), 0);
  const approved = sum('approvedRefactors') + sum('approvedAdjustments');
  const declined = sum('declinedRefactors') + sum('declinedAdjustments');
  return {
    n: issues.length,
    quotaFailures: quotaFailures.length,
    firstPassYield: yieldOf(reached),
    byComplexity,
    triageMiss: { cleared: cleared.length, miss, rate: cleared.length ? miss / cleared.length : 0 },
    bounceRate: mean(reached.map((r) => r.bounces ?? 0)),
    hitl: { pointA: hitlOf('pointA'), pointB: hitlOf('pointB') },
    reviewCatch: { reached: reached.length, blocking, rate: reached.length ? blocking / reached.length : 0 },
    retro: {
      passes: retros.length,
      mergedPrs: retros.reduce((a, r) => a + (r.mergedPrs?.length ?? 0), 0),
      proposed: sum('proposedRefactors') + sum('proposedAdjustments'),
      approved,
      declined,
      filed: retros.reduce((a, r) => a + (r.filed?.length ?? 0), 0),
      approvalRate: approved + declined ? approved / (approved + declined) : 0,
    },
  };
}

/** Render the human-readable indicator table (the stderr half of `report`). */
export function renderReport(rep) {
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    `records:           ${rep.n}`,
  ];
  // Gated on quotaFailures > 0 so a quota-failure-free log renders
  // byte-identically to before this field existed.
  if (rep.quotaFailures > 0) lines.push(`quota failures:    ${rep.quotaFailures}`);
  lines.push(`first-pass yield:  ${rep.firstPassYield.pass}/${rep.firstPassYield.reached} (${pct(rep.firstPassYield.rate)})`);
  for (const tier of TIERS) {
    const y = rep.byComplexity[tier];
    lines.push(`  ${tier.padEnd(11)}${y.pass}/${y.reached} (${pct(y.rate)})`);
  }
  lines.push(
    `triage-miss proxy: ${rep.triageMiss.miss}/${rep.triageMiss.cleared} (${pct(rep.triageMiss.rate)})`,
    `mean bounces:      ${rep.bounceRate.toFixed(2)}`,
    `review-catch:      ${rep.reviewCatch.blocking}/${rep.reviewCatch.reached} (${pct(rep.reviewCatch.rate)})`,
    `HITL point-A:      ${rep.hitl.pointA.count}/${rep.hitl.pointA.n} (${pct(rep.hitl.pointA.rate)})`,
    `HITL point-B:      ${rep.hitl.pointB.count}/${rep.hitl.pointB.n} (${pct(rep.hitl.pointB.rate)})`,
  );
  // Gated on passes > 0 so a retro-free log renders byte-identically to before
  // the retro record kind existed (the field report quotes this table verbatim).
  if (rep.retro.passes > 0) {
    lines.push(
      `retro passes:      ${rep.retro.passes} (${rep.retro.mergedPrs} PRs)`,
      `  proposals:       ${rep.retro.proposed} proposed, ${rep.retro.approved} approved, ${rep.retro.declined} declined (${pct(rep.retro.approvalRate)} approved)`,
      `  tickets filed:   ${rep.retro.filed}`,
    );
  }
  return lines.join('\n');
}

/** A failed ingest; `code` is the CLI exit status: 2 for a bad invocation or half-supplied wave, 3 for a malformed artifact. */
class IngestError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const OUTCOME_RULES = {
  pr: [isPr, 'a positive integer'],
  finalState: [(v) => FINAL_STATES.has(v), `one of ${[...FINAL_STATES].join('|')}`],
  bounces: [(v) => Number.isInteger(v) && v >= 0, 'a non-negative integer'],
  findings: [(v) => Array.isArray(v) && v.every((f) => typeof f === 'string'), 'an array of strings'],
  tokens: [(v) => v === null || (typeof v === 'number' && Number.isFinite(v)), 'a number or null'],
  pressureOverride: [(v) => v === true, 'true (omit the field when no override ran)'],
};

/**
 * Throw an exit-2 IngestError naming the ref and field of the first `--outcomes` violation: a bad
 * value, a field outside `OUTCOME_RULES` and `hitl.pointB` (a misspelled one would be dropped), a
 * `pr` other than the report row's (which would win), or `finalState: "merged"` where neither the
 * report row nor the outcome has a PR.
 */
function validateOutcomes(outcomes, rows) {
  if (!outcomes || typeof outcomes !== 'object' || Array.isArray(outcomes)) throw new IngestError(2, '--outcomes must be an object keyed by ref');
  for (const [ref, o] of Object.entries(outcomes)) {
    const row = rows.find((r) => r.ref === ref);
    if (!row) throw new IngestError(2, `--outcomes names ${ref}, which is not in the report`);
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new IngestError(2, `--outcomes ${ref} must be an object`);
    const unknown = Object.keys(o).find((k) => k !== 'hitl' && !Object.hasOwn(OUTCOME_RULES, k));
    if (unknown) throw new IngestError(2, `--outcomes ${ref}: unknown field ${unknown} (known: ${Object.keys(OUTCOME_RULES).join(', ')}, hitl.pointB)`);
    for (const [field, [ok, want]] of Object.entries(OUTCOME_RULES)) {
      if (o[field] !== undefined && !ok(o[field])) throw new IngestError(2, `--outcomes ${ref}: ${field} must be ${want}, got ${JSON.stringify(o[field])}`);
    }
    if (o.pr !== undefined && isPr(row.prNumber) && o.pr !== row.prNumber) {
      throw new IngestError(2, `--outcomes ${ref}: pr ${o.pr} is not the report row's PR ${row.prNumber}`);
    }
    if (o.finalState === 'merged' && !isPr(row.prNumber) && o.pr === undefined) {
      throw new IngestError(2, `--outcomes ${ref}: finalState merged needs a PR, and neither the report row nor --outcomes has one`);
    }
    if (o.hitl === undefined) continue;
    if (typeof o.hitl?.pointB !== 'boolean') throw new IngestError(2, `--outcomes ${ref}: hitl.pointB must be a boolean, got ${JSON.stringify(o.hitl?.pointB)}`);
    const extra = Object.keys(o.hitl).find((k) => k !== 'pointB');
    if (extra) throw new IngestError(2, `--outcomes ${ref}: unknown field hitl.${extra} (known: hitl.pointB)`);
  }
}

/**
 * Record a wave from its engine artifacts: derive its issue records (`deriveWaveRecords`), attach to
 * each that reached implement the `cost.implement` read from its ref's transcript (`implementCost`,
 * over the sessions no earlier record of the run family lists), and append the ones the log lacks. `reportPath` is
 * `<stateDir>/state/reports/<id>.json`; everything else is read from beside it, except that review rounds,
 * and the later reports that end their window, come from every run-family dir (`runFamilyDirs`), or from the
 * state dir alone, with a warning, when the dir holding the family cannot be listed. Appends are
 * best-effort: a failed one is warned about and the rest continue.
 * @param {string} reportPath
 * @param {Record<string, object>} outcomes per-ref `{pr, hitl:{pointB}, finalState, bounces, findings, tokens}`
 * @param {{path?: string, warn?: (m: string) => void}} [opts]
 * @returns {{records: object[], appended: number}} `records` are the ones derived as new
 * @throws {IngestError} code 2 for a report outside `<stateDir>/state/reports/`, bad `--outcomes` or a
 *   half-supplied wave, 3 for a malformed report or no run id; any other error (an unreadable log,
 *   a bug) is thrown as is
 */
export function ingestWave(reportPath, outcomes, { path = telemetryPath(), warn = (m) => console.error(m) } = {}) {
  const file = resolve(reportPath);
  // Everything else is found from the state dir, so a report out of place would record defaults.
  if (basename(dirname(file)) !== 'reports' || basename(dirname(dirname(file))) !== 'state') {
    throw new IngestError(2, `${file}: not at <stateDir>/state/reports/<id>.json, so its state dir is unknown`);
  }
  const stateDir = dirname(dirname(dirname(file)));
  // Its siblings are read quietly: only this report's own fault is an error here. A path the listing
  // lacks (a missing file, or one not named *.json) is read alone, so it fails or reads as it always did.
  const reports = readWaveReports(stateDir, { warn: () => {} });
  const own = reports.find((r) => r.path === file) ?? readWaveReport(file);
  if (!own.report) throw new IngestError(3, own.error);
  const { report, startedAt } = own;
  if (own.error) throw new IngestError(3, own.error);
  const refs = report.issues.map((r) => r.ref);
  validateOutcomes(outcomes, report.issues);

  // Routing emitted after this report started is a later re-emit's (a retry's), not this wave's.
  // An older layout kept the config under <stateDir>/state/.
  const { entry, config, source } = waveContextFor(stateDir, own, { warn });
  if (source !== 'sidecar') {
    warn(entry
      ? `ingest-wave: no sidecar entry in ${stateDir} matches this wave's issues; routing from its config, recorded under the default policy at tuningVersion 0`
      : `ingest-wave: no sidecar entry or config in ${stateDir} matches this wave's issues; complexity and routing are unknown`);
  }
  // Only a config says which repos run no post-session check, so without one every succeeded row reads "pass".
  if (!config && report.issues.some((r) => r?.status === 'succeeded')) {
    warn(`ingest-wave: no config in ${stateDir} matches this wave's issues, so which repos run no post-session check is unknown; succeeded rows record ciStatus "pass"`);
  }

  // Review rounds are the run's, not the engine dir's: a retry dir (sd-…-w3c) keeps its rounds under the
  // base run's reviews/. So rounds are read from every run-family dir (the run id as deriveWaveRecords
  // takes it), and a later report in any of them ends this wave's window. A dir is told apart by inode, since
  // a path typed in another case names the same dir as the listing's on a case-insensitive file system.
  // A base dir that cannot be listed leaves this dir's rounds, as before rounds were the run's, rather than no record.
  let siblings = [];
  try {
    siblings = runFamilyDirs(entry?.runId || runIdFromConfigName(report.configName), dirname(stateDir));
  } catch (err) {
    warn(`ingest-wave: cannot list ${dirname(stateDir)} (${err.code ?? err.message}), so review rounds and later reports are read from ${stateDir} alone`);
  }
  const inodes = new Set();
  const family = [stateDir, ...siblings]
    .filter((d) => { const { dev, ino } = statSync(d); const key = `${dev}:${ino}`; return !inodes.has(key) && Boolean(inodes.add(key)); });
  const { inWave, digests } = waveWindow(stateDir, own, family.flatMap((d) => (d === stateDir ? reports : readWaveReports(d, { warn: () => {} }))), warn);

  const rounds = {};
  for (const ref of refs) {
    rounds[ref] = reviewRoundFiles(family.map((d) => join(d, 'reviews')), ref)
      .filter((f) => inWave(ref, f.mtimeMs))
      .map((f) => {
        try { return { path: f.path, review: JSON.parse(readFileSync(f.path, 'utf8')) }; } catch { return { path: f.path, review: null }; }
      });
  }

  // Read outside the try below: an unreadable log is not a malformed report.
  const existing = readRecords(path);
  let records;
  try {
    // A sidecar entry carries its wave's tuningVersion; a wave without one ran before the sidecar
    // did, and epic #64 reads a missing version as 0, never as today's.
    ({ records } = deriveWaveRecords(report, entry, digests, rounds, outcomes, {
      existing, warn, tuningVersion: 0, reportId: basename(file, '.json'),
      // The engine (resolveRepoSettings) runs a repo's own postSessionCheck, else the config's top-level one, else none.
      noCheckRepos: [...new Set((config?.issues ?? []).map((i) => i.repo))].filter((repo) => !(config.repos?.[repo]?.postSessionCheck ?? config.postSessionCheck)),
    }));
  } catch (err) {
    // deriveWaveRecords' refusals, each cause with its own remedy; anything else is a bug, not a bad artifact, and is thrown as is.
    if (err instanceof WaveRefusal && err.kind === 'half-supplied') {
      const remedies = [
        err.noPr?.length && `For a find-pr row, pass the PR step 5's lookup found as --outcomes '{"<ref>":{"pr":N}}', `
          + `or, when point B left it without one, '{"<ref>":{"finalState":"blocked-hitl","hitl":{"pointB":true}}}'`,
        err.lastBlocks?.length && `For a PR whose last round blocks, pass '{"<ref>":{"finalState":"blocked-hitl","hitl":{"pointB":true}}}' when it went to point B unmerged, `
          + `or '{"<ref>":{"finalState":"merged","bounces":N}}' when it merged after a /review-loop fix whose round file is missing`,
      ].filter(Boolean);
      throw new IngestError(2, [err.message, ...remedies].join('. '));
    }
    if (err instanceof WaveRefusal) throw new IngestError(3, `${file}: ${err.message}`);
    throw err;
  }
  // A row with no record, or a skipped one (implStatus null: it never reached implement), leaves its
  // sessions for the ref's next record; a session an earlier record of the run family lists, in the
  // log or earlier in this wave (a point-E row derives a death and an outcome), is not counted again.
  const taken = [];
  for (const rec of records) {
    if (rec.implStatus === null) continue;
    const counted = [...existing, ...taken].filter((e) => sameRepo(e.repo, rec.repo) && e.issue === rec.issue && sameRun(e.runId, rec.runId)).flatMap((e) => e.cost?.implement?.sessionIds ?? []);
    // The engine named the log from the row's ref as written, so find that row, as written, rather than rebuild it.
    const ref = refs.find((r) => { const p = parseRef(r); return p?.repo === rec.repo && p.number === rec.issue; });
    const implement = implementCost(logPathForRef(stateDir, ref), counted, warn);
    if (implement) { rec.cost = { implement }; taken.push(rec); }
  }
  let appended = 0;
  for (const rec of records) {
    try { appendRecord(rec, { path }); appended += 1; } catch (err) { warn(`ingest-wave: could not append ${rec.repo}#${rec.issue} (${rec.finalState}): ${err.message}`); }
  }
  return { records, appended };
}

/**
 * The window of the wave report `own` (in `stateDir`, among `familyReports`, the run family's reports as
 * `readWaveReports` reads them) and the failure digests it holds: ingest's and audit's one reading of them.
 * A digest the engine stamped with a report id (`reportId`) belongs to that report's wave and no other, whatever
 * its mtime (a copied state dir loses mtimes). An unstamped digest (written before stamping), and every review
 * round, which agents write from SKILL.md prose with no script writer to stamp it, keep the mtime window below:
 * the rounds are the remaining heuristic. A digest or review round belongs to this wave when it was written after this report started and
 * before the next report that re-ran the ref did: a retry or a later wave rewrites the ref's digest
 * and re-reviews it. A report that only carries the row over with the same PR (a --retry-failed
 * run of other rows) re-runs nothing, so later rounds still review this row's PR. A later report
 * refused for a malformed row still started when it says, so it still ends the window.
 * @returns {{inWave: (ref: string, mtimeMs: number) => boolean, digests: Record<string, object>}} `digests` by ref,
 *   for the rows that did not succeed (deriveWaveRecords records only terminal rows and ignores a succeeded row's stale digest)
 */
function waveWindow(stateDir, { report, startedAt, path: reportPath }, familyReports, warn) {
  const others = familyReports.filter((r) => Number.isFinite(r.startedAt) && r.startedAt > startedAt);
  const reran = ({ report: rep }, row) => rep.issues.some((r) => r?.ref === row.ref && !(isPr(row.prNumber) && r.prNumber === row.prNumber));
  const ends = Object.fromEntries(report.issues.map((row) => [row.ref, Math.min(Infinity, ...others.filter((rep) => reran(rep, row)).map((rep) => rep.startedAt))]));
  const inWave = (ref, mtimeMs) => mtimeMs >= startedAt && mtimeMs < ends[ref];
  const digests = {};
  for (const r of report.issues.filter((i) => ['failed', 'blocked', 'skipped'].includes(i?.status))) {
    const p = digestPathForRef(stateDir, r.ref);
    let mtimeMs;
    try { ({ mtimeMs } = statSync(p)); } catch { continue; }
    let digest;
    try { digest = JSON.parse(readFileSync(p, 'utf8')); } catch (err) { digest = err; }
    const stamped = typeof digest?.reportId === 'string';
    if (stamped ? digest.reportId !== basename(reportPath, '.json') : !inWave(r.ref, mtimeMs)) { warn(`${p}: written outside this wave; ignored`); continue; }
    if (digest instanceof Error) { warn(`${p}: unreadable digest (${digest.message}); ignored`); continue; }
    digests[r.ref] = digest;
  }
  return { inWave, digests };
}

/**
 * Audit a run family against the log. Every dir of `runFamilyDirs(runId, baseDir)` is read for its
 * reports; a readable one with a terminal row `rowCovered` finds no record for (handed the row's digest as
 * `waveWindow` reads it for ingest) is `notIngested`
 * (`{dir, id, source (where its routing label came from), refs (the uncovered rows')}`; one with no
 * terminal row is not named), and one with an `error` is `unreadable` (`{path, error}`). `terminalRows`
 * is the number of terminal rows examined (a row a retry carries over counts once per report that lists it,
 * as `notIngested` names it) and `prRows` those with a PR, `{total, uncovered}`: the denominators for a coverage share. A sidecar
 * entry or config file (in either of `configDirs`) that no readable report matched is `neverReported`:
 * there is no report to ingest. That is a wave the engine died in before it wrote one, but also a wave
 * still running, an earlier emit of a ref set whose re-emit a report matched, and an `unreadable` report's.
 * @param {string} runId
 * @param {{baseDir?: string, records?: object[], warn?: (m: string) => void}} [opts] `records` is the telemetry log
 * @throws when no dir under `baseDir` belongs to the run family, so a mistyped id does not read as all clear
 */
export function audit(runId, { baseDir = defaultBaseDir(), records = readRecords(telemetryPath()), warn = (m) => console.error(m) } = {}) {
  const out = { runId, dirs: runFamilyDirs(runId, baseDir), terminalRows: 0, prRows: { total: 0, uncovered: 0 }, notIngested: [], unreadable: [], neverReported: { sidecar: [], configs: [] } };
  if (!out.dirs.length) throw new Error(`no dir under ${baseDir} belongs to run ${runId}`);
  const logged = records.filter((r) => sameRun(r.runId, runId));
  // Quiet: an unreadable report is named in `unreadable`, so it is not warned about as well.
  const reads = out.dirs.map((dir) => readWaveReports(dir, { warn: () => {} }));
  for (const [i, dir] of out.dirs.entries()) {
    const matched = new Set();
    for (const read of reads[i]) {
      if (read.error) { out.unreadable.push({ path: read.path, error: read.error }); continue; }
      // Quiet: the sidecar is read once more below, so a torn line is warned about once per dir, not per report.
      const { entry, configFile, source } = waveContextFor(dir, read, { warn: () => {} });
      if (source === 'sidecar') matched.add(JSON.stringify(entry));
      if (configFile) matched.add(configFile);
      // Quiet: a digest outside the window, or unreadable, is ingest's to warn about.
      const { digests } = waveWindow(dir, read, reads.flat(), () => {});
      const terminal = read.report.issues.filter((r) => TERMINAL.has(r?.status));
      const uncovered = terminal.filter((r) => !rowCovered(r, read, logged, runId, digests[r.ref]));
      out.terminalRows += terminal.length;
      out.prRows.total += terminal.filter((r) => isPr(r.prNumber)).length;
      out.prRows.uncovered += uncovered.filter((r) => isPr(r.prNumber)).length;
      const refs = uncovered.map((r) => r.ref);
      if (refs.length) out.notIngested.push({ dir, id: read.id, source, refs });
    }
    for (const e of readSidecar(join(dir, SIDECAR_NAME), { warn })) {
      if (!matched.has(JSON.stringify(e))) out.neverReported.sidecar.push({ dir, refs: (e.issues ?? []).map((i) => i?.ref) });
    }
    for (const { configFile } of configDirs(dir).flatMap((d) => waveConfigs(d))) if (!matched.has(configFile)) out.neverReported.configs.push(configFile);
  }
  return out;
}

function readArg(src) {
  if (src === '-') return readFileSync(0, 'utf8');
  if (src.startsWith('@')) return readFileSync(src.slice(1), 'utf8');
  return src;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'append') {
    const src = rest[0];
    if (!src) { process.stderr.write('usage: append <json|@file|->\n'); process.exit(2); }
    const norm = appendRecord(JSON.parse(readArg(src)), { path: telemetryPath() });
    const what = norm.kind === 'retro'
      ? `retro (wave ${norm.wave}, ${norm.filed.length} filed)`
      : `${norm.repo}#${norm.issue} (${norm.finalState})`;
    process.stderr.write(`appended ${what} → ${telemetryPath()}\n`);
    return;
  }
  if (cmd === 'report') {
    let since = null;
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '--since') {
        since = rest[++i];
        if (!since) { process.stderr.write('--since requires an ISO timestamp\n'); process.exit(2); }
      }
    }
    let records = readRecords(telemetryPath());
    if (since) records = records.filter((r) => r.ts >= since);
    const rep = report(records);
    process.stdout.write(`${JSON.stringify(rep, null, 2)}\n`);
    process.stderr.write(`${renderReport(rep)}\n`);
    return;
  }
  if (cmd === 'ingest-wave') {
    let file, outcomes;
    try {
      const { values, positionals } = parseArgs({ args: rest, options: { outcomes: { type: 'string' } }, allowPositionals: true });
      if (positionals.length !== 1) throw new Error(`expected one report, got ${positionals.length}`);
      [file] = positionals;
      outcomes = values.outcomes === undefined ? {} : JSON.parse(readArg(values.outcomes));
    } catch (err) {
      process.stderr.write(`ingest-wave: ${err.message}\nusage: ingest-wave <report> [--outcomes <json|@file|->]\n`);
      process.exit(2);
    }
    try {
      const { records, appended } = ingestWave(file, outcomes);
      process.stderr.write(`ingest-wave: ${records.length} new record(s), ${appended} appended → ${telemetryPath()}\n`);
    } catch (err) {
      process.stderr.write(`ingest-wave: ${err.message}\n`);
      process.exit(err instanceof IngestError ? err.code : 1);
    }
    return;
  }
  if (cmd === 'escapes') {
    const i = rest.indexOf('--now');
    const now = i >= 0 ? Date.parse(rest[i + 1]) : Date.now();
    if (Number.isNaN(now)) { process.stderr.write('--now requires an ISO timestamp\n'); process.exit(2); }
    shipDagPrs(readRecords(telemetryPath()))
      .then((prs) => findEscapes(prs, { now }))
      .then((rows) => process.stdout.write(`${JSON.stringify(escapeReport(rows), null, 2)}\n`))
      .catch((err) => { process.stderr.write(`escapes: ${err.message}\n`); process.exit(1); });
    return;
  }
  if (cmd === 'audit') {
    if (rest.length !== 1) { process.stderr.write('usage: audit <runId>\n'); process.exit(2); }
    try {
      process.stdout.write(`${JSON.stringify(audit(rest[0]), null, 2)}\n`);
    } catch (err) {
      process.stderr.write(`audit: ${err.message}\n`);
      process.exit(1);
    }
    return;
  }
  if (cmd === 'tripwires') {
    let values;
    try {
      ({ values } = parseArgs({ args: rest, options: { escapes: { type: 'string' }, now: { type: 'string' } } }));
      if (values.now !== undefined && Number.isNaN(Date.parse(values.now))) throw new Error('--now requires an ISO timestamp');
    } catch (err) {
      process.stderr.write(`tripwires: ${err.message}\nusage: tripwires [--escapes <file>] [--now ISO]\n`);
      process.exit(2);
    }
    try {
      const records = readRecords(telemetryPath());
      const escapes = values.escapes === undefined ? undefined : JSON.parse(readFileSync(values.escapes, 'utf8'));
      const ctx = tripwireContext(records, {
        version: loadTuning().version, now: values.now === undefined ? Date.now() : Date.parse(values.now), escapes,
        audit: (runId) => audit(runId, { records, warn: () => {} }),
      });
      process.stdout.write(`${JSON.stringify(evaluateAll(loadTripwires(), ctx), null, 2)}\n`);
    } catch (err) {
      process.stderr.write(`tripwires: ${err.message}\n`);
      process.exit(1);
    }
    return;
  }
  if (cmd === 'run-id') {
    const i = rest.indexOf('--label');
    process.stdout.write(`${process.env.SHIP_DAG_RUN_ID || mintRunId({ label: i >= 0 ? rest[i + 1] : undefined })}\n`);
    return;
  }
  process.stderr.write('usage: telemetry.mjs <append|report|ingest-wave|escapes|audit|tripwires|run-id> ...\n');
  process.exit(2);
}

// Only run the CLI when invoked directly, not when imported by the test.
if (isMain(import.meta.url)) main(process.argv.slice(2));
