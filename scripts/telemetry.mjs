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
//   issue: { kind, ts, runId, repo, issue, complexity, triageStatus, assignment, path,
//            implStatus, ciStatus, reviewVerdict, failureReason, findings[], bounces,
//            hitl:{pointA,pointB}, finalState, pr, tokens }
//   retro: { kind, ts, runId, wave, mergedPrs[], proposedRefactors, approvedRefactors,
//            declinedRefactors, proposedAdjustments, approvedAdjustments,
//            declinedAdjustments, filed[], adjusted[], declinedTitles[], tokens }
// implStatus / ciStatus / reviewVerdict are nullable: an issue that stops at
// HITL point A (needs-decision) never reaches implement, so it logs those null.
// failureReason is also nullable — set to "rate-limited" alongside
// implStatus: "error" when the wrapper (scripts/rate-limit-preflight.mjs /
// scripts/lib/rate-limit.mjs) identifies the five-hour window as the cause,
// so the eval harness can separate quota failures from model failures.
//
// Usage:
//   node telemetry.mjs run-id [--label L]    # mint (or echo $SHIP_DAG_RUN_ID) this run's id
//   node telemetry.mjs append '<json>'      # append one record (validates + stamps ts)
//   node telemetry.mjs append @rec.json      # ...from a file
//   node telemetry.mjs append -              # ...from stdin
//   node telemetry.mjs ingest-wave <report.json> --outcomes <json|@file|->
//                                            # close a whole engine wave: derive every
//                                            # record the engine's own artifacts already
//                                            # know, supply only the judgement half
//   node telemetry.mjs audit [--base-dir D]  # engine waves on disk vs. records in the log
//   node telemetry.mjs report [--since ISO]  # print leading indicators (JSON + table)
//
// `ingest-wave` is the structural emission point (SKILL.md steps 5-6). Emission
// used to be five separate prose instructions to the main agent, and under-emitted
// exactly when a run was long and multi-wave; `ingest-wave` collapses a whole wave
// into one call whose derivable half cannot be mistyped and whose judgement half,
// if incomplete, is REFUSED with the forgotten refs named rather than half-written.
// `audit` is the backstop: engine reports persist on disk, so a wave that was never
// ingested stays recoverable instead of being lost.
//
// Path resolution: $SHIP_DAG_TELEMETRY, else $XDG_STATE_HOME/ship-dag/runs.jsonl,
// else ~/.local/state/ship-dag/runs.jsonl.

import { appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { mean, rate, groupBy } from './lib/stats.mjs';
import { isMain } from './lib/is-main.mjs';
import {
  mintRunId,
  runIdFromConfigName,
  canonicalRunId,
  parseRef,
  deriveWaveRecords,
} from './lib/wave-records.mjs';

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

/**
 * The identity a record occupies in the log: one issue's outcome within one
 * run, or one retrospective pass. Two records with the same key are the same
 * fact written twice, so a re-run of a wave close is a no-op rather than a
 * doubling. `finalState` + `failureReason` are part of the key deliberately:
 * a rate-limit death record and the merge record for the same issue in the
 * same run are two *different* facts (see `report()`), and both must survive.
 * @param {object} rec
 * @returns {string}
 */
export function recordKey(rec) {
  if ((rec.kind ?? 'issue') === 'retro') return `retro|${rec.runId}|${rec.wave}`;
  return `issue|${rec.runId}|${rec.repo}#${rec.issue}|${rec.finalState}|${rec.failureReason ?? ''}`;
}

/**
 * Append a batch of records, skipping any whose `recordKey` is already in the
 * log (or repeated inside the batch), in a single read + single write.
 *
 * Never throws: a record that fails validation is collected in `failed` and the
 * rest of the batch still lands. Emission is best-effort by contract — a broken
 * telemetry write must never take down a wave — so one malformed record can't
 * cost the wave its other records.
 * @param {object[]} records
 * @param {{path?: string, now?: () => string}} [opts]
 * @returns {{appended: object[], skipped: object[], failed: Array<{record: object, error: string}>}}
 */
export function appendUniqueRecords(records, { path = telemetryPath(), now } = {}) {
  const appended = [];
  const skipped = [];
  const failed = [];
  if (!records || records.length === 0) return { appended, skipped, failed };
  const seen = new Set(readRecords(path).map(recordKey));
  const lines = [];
  for (const rec of records) {
    let norm;
    try {
      norm = normalizeRecord(rec, now);
    } catch (err) {
      failed.push({ record: rec, error: err.message });
      continue;
    }
    const key = recordKey(norm);
    if (seen.has(key)) {
      skipped.push(norm);
      continue;
    }
    seen.add(key);
    lines.push(`${JSON.stringify(norm)}\n`);
    appended.push(norm);
  }
  if (lines.length > 0) {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, lines.join(''));
  }
  return { appended, skipped, failed };
}

/** Default base dir holding every run's engine state (SKILL.md step 4a). */
export function defaultEngineBaseDir(env = process.env) {
  const stateHome = env.XDG_STATE_HOME || `${env.HOME}/.local/state`;
  return `${stateHome}/ship-dag/engine`;
}

/**
 * The wave context sitting beside an engine report: the `ship-dag-wave.json`
 * sidecar emit-config.mjs writes (preferred — it is the only artifact carrying
 * the wave number and the point-A deferrals), else the `config.json` the engine
 * was handed. Either supplies each issue's triage `complexity` and assigned
 * model, which the report itself does not record.
 *
 * `<stateDir>/state/reports/<ISO>.json` → `<stateDir>` is three levels up.
 * @param {string} reportPath
 * @returns {{stateDir: string, source: string|null, context: object|null}}
 */
export function loadWaveContext(reportPath) {
  const stateDir = dirname(dirname(dirname(resolve(reportPath))));
  for (const name of ['ship-dag-wave.json', 'config.json']) {
    const p = join(stateDir, name);
    try {
      return { stateDir, source: p, context: JSON.parse(readFileSync(p, 'utf8')) };
    } catch {
      // missing or unreadable — fall through to the next candidate
    }
  }
  return { stateDir, source: null, context: null };
}

/**
 * Every engine wave report under a base dir
 * (`<baseDir>/<stateDirName>/state/reports/*.json`), sorted for determinism.
 * Never throws: a missing base dir, or a run subdir with no reports, is simply
 * no candidate.
 * @param {string} baseDir
 * @returns {string[]}
 */
export function findWaveReports(baseDir) {
  let runDirs;
  try {
    runDirs = readdirSync(baseDir);
  } catch {
    return [];
  }
  const out = [];
  for (const runDir of runDirs) {
    const reportsDir = join(baseDir, runDir, 'state', 'reports');
    let names;
    try {
      names = readdirSync(reportsDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith('.json')) out.push(join(reportsDir, name));
    }
  }
  return out.sort();
}

/**
 * Reconcile the engine waves that actually ran (their reports are durable, on
 * disk, under the one well-known base dir) against the records in the log.
 * This is what turns chronic under-emission from invisible into a number: a
 * wave that shipped five issues and logged two shows up here as three refs by
 * name, and — because the report survives — can still be ingested afterwards.
 *
 * A row recorded under a *different* runId is reported as `elsewhere` rather
 * than `missing`: the datum exists, but per-run grouping lost it.
 * @param {{baseDir?: string, records?: object[]}} [opts]
 * @returns {{waves: object[], expected: number, missing: string[], elsewhere: string[]}}
 */
export function auditWaves({ baseDir = defaultEngineBaseDir(), records = [] } = {}) {
  const byRunRef = new Set();
  const byRef = new Set();
  for (const r of records) {
    if ((r.kind ?? 'issue') === 'retro') continue;
    const ref = `${r.repo}#${r.issue}`;
    byRunRef.add(`${canonicalRunId(r.runId)}|${ref}`);
    byRef.add(ref);
  }
  const waves = [];
  const missing = [];
  const elsewhere = [];
  let expected = 0;
  for (const reportPath of findWaveReports(baseDir)) {
    let rep;
    try {
      rep = JSON.parse(readFileSync(reportPath, 'utf8'));
    } catch {
      continue; // a torn/half-written report is not evidence of a gap
    }
    const { context } = loadWaveContext(reportPath);
    const runId = context?.runId
      || runIdFromConfigName(context?.name)
      || runIdFromConfigName(rep.configName);
    const wave = { report: reportPath, runId, expected: 0, present: 0, missing: [], elsewhere: [] };
    for (const row of Array.isArray(rep.issues) ? rep.issues : []) {
      const parsed = parseRef(row.ref);
      if (!parsed) continue; // a row with no composite ref can't be matched to a record
      const ref = `${parsed.repo}#${parsed.issue}`;
      wave.expected += 1;
      if (byRunRef.has(`${canonicalRunId(runId)}|${ref}`)) {
        wave.present += 1;
      } else if (byRef.has(ref)) {
        wave.elsewhere.push(ref);
      } else {
        wave.missing.push(ref);
      }
    }
    expected += wave.expected;
    missing.push(...wave.missing);
    elsewhere.push(...wave.elsewhere);
    waves.push(wave);
  }
  return { waves, expected, missing, elsewhere };
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

function readArg(src) {
  if (src === '-') return readFileSync(0, 'utf8');
  if (src.startsWith('@')) return readFileSync(src.slice(1), 'utf8');
  return src;
}

/** Pull `--flag value` / `--flag` out of an argv tail into a plain object. */
function parseFlags(rest) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i += 1; }
  }
  return { flags, positional };
}

/** `ingest-wave`: derive a whole engine wave's records and append the new ones. */
function ingestWave(rest) {
  const { flags, positional } = parseFlags(rest);
  const reportPath = positional[0];
  if (!reportPath) {
    process.stderr.write('usage: ingest-wave <report.json> --outcomes <json|@file|-> [--run-id R] [--config P] [--allow-missing] [--dry-run]\n');
    process.exit(2);
  }
  const report_ = JSON.parse(readFileSync(reportPath, 'utf8'));
  const loaded = typeof flags.config === 'string'
    ? { source: flags.config, context: JSON.parse(readFileSync(flags.config, 'utf8')) }
    : loadWaveContext(reportPath);
  // The wave's own artifacts outrank the ambient env var: a stale exported
  // SHIP_DAG_RUN_ID from an earlier run must not relabel this wave's records.
  const runId = (typeof flags['run-id'] === 'string' && flags['run-id'])
    || loaded.context?.runId
    || runIdFromConfigName(loaded.context?.name)
    || process.env.SHIP_DAG_RUN_ID
    || undefined;
  const outcomes = typeof flags.outcomes === 'string' ? JSON.parse(readArg(flags.outcomes)) : undefined;
  const { records, missing, unknown } = deriveWaveRecords({
    report: report_, config: loaded.context, runId, outcomes,
  });
  if (records.length > 0 && !records[0].runId) {
    // Without a run id the records are ungroupable, which is the exact failure
    // this command exists to prevent — say so rather than letting each record
    // fail validation one by one.
    process.stderr.write('telemetry: REFUSED — no run id: pass --run-id, export SHIP_DAG_RUN_ID, or give the config a ship-dag-<runId> name\n');
    process.exit(2);
  }
  if (unknown.length > 0) {
    process.stderr.write(`telemetry: WARNING — outcome supplied for ${unknown.length} ref(s) this report never ran: ${unknown.join(', ')}\n`);
  }
  if (missing.length > 0 && !flags['allow-missing']) {
    // The under-emission defect, made loud: a half-supplied wave is refused
    // whole rather than half-written, and every forgotten ref is named. The
    // engine report is durable, so re-running with the rest costs nothing.
    process.stderr.write(
      `telemetry: REFUSED — no outcome supplied for ${missing.length} of ${missing.length + records.length} issue(s) in this wave:\n`
      + missing.map((r) => `  ${r}\n`).join('')
      + 'Supply { finalState, reviewVerdict?, findings?, bounces?, hitl? } for each, then re-run.\n'
      + 'Pass --allow-missing to record only the issues you did supply.\n',
    );
    process.exit(2);
  }
  if (flags['dry-run']) {
    process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    process.stderr.write(`telemetry: dry run — ${records.length} record(s), nothing written\n`);
    return;
  }
  const { appended, skipped, failed } = appendUniqueRecords(records, { path: telemetryPath() });
  for (const f of failed) process.stderr.write(`telemetry: WARNING — dropped a record: ${f.error}\n`);
  const notes = [`appended ${appended.length}`];
  if (skipped.length) notes.push(`${skipped.length} already logged`);
  if (failed.length) notes.push(`${failed.length} invalid`);
  if (missing.length) notes.push(`${missing.length} unsupplied`);
  process.stderr.write(`${notes.join(', ')} → ${telemetryPath()}\n`);
}

/** `audit`: engine waves that ran on disk vs. records that reached the log. */
function auditCli(rest) {
  const { flags } = parseFlags(rest);
  const baseDir = typeof flags['base-dir'] === 'string' ? flags['base-dir'] : defaultEngineBaseDir();
  const result = auditWaves({ baseDir, records: readRecords(telemetryPath()) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  const lines = [
    `engine waves:      ${result.waves.length} under ${baseDir}`,
    `issue rows:        ${result.expected}`,
    `unrecorded:        ${result.missing.length}`,
    `logged under another runId: ${result.elsewhere.length}`,
  ];
  for (const w of result.waves) {
    if (w.missing.length === 0 && w.elsewhere.length === 0) continue;
    lines.push(`  ${w.runId ?? '(unknown run)'} — ${w.present}/${w.expected} recorded`
      + (w.missing.length ? `; missing ${w.missing.join(', ')}` : '')
      + (w.elsewhere.length ? `; elsewhere ${w.elsewhere.join(', ')}` : ''));
  }
  process.stderr.write(`${lines.join('\n')}\n`);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'run-id') {
    // Minted here rather than in the agent's head: an id invented per-message
    // drifts, and per-run grouping is exactly what drift destroys.
    const { flags } = parseFlags(rest);
    const existing = process.env.SHIP_DAG_RUN_ID;
    const label = typeof flags.label === 'string' ? flags.label : undefined;
    process.stdout.write(`${existing || mintRunId({ label })}\n`);
    return;
  }
  if (cmd === 'ingest-wave') return ingestWave(rest);
  if (cmd === 'audit') return auditCli(rest);
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
  process.stderr.write('usage: telemetry.mjs <run-id|append|ingest-wave|audit|report> ...\n');
  process.exit(2);
}

// Only run the CLI when invoked directly, not when imported by the test.
if (isMain(import.meta.url)) main(process.argv.slice(2));
