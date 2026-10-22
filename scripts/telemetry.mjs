#!/usr/bin/env node
// telemetry.mjs — append-only run log for /ship-dag + a leading-indicator report.
//
// Every issue that reaches a terminal-for-this-wave state emits one JSON record
// (schema in references/telemetry-schema.md). The log is append-only and lives OUTSIDE the ~/.claude repo
// (under the XDG state dir) so collected run data can never be accidentally
// committed. Pure aggregation math is imported from ./lib/stats.mjs; this file
// owns only validation, the file I/O, and the CLI.
//
// Record schema: references/telemetry-schema.md is the one authored description of the issue and retro
// records (every key, the closed `skipReason` set, both accepted `findings` shapes and the legacy ones
// that stay readable but that `append` refuses). Records carry a `kind` discriminator — "issue" (default;
// stamped when absent, so pre-existing logs stay valid) or "retro" (one run-scoped record per step-6.5 pass).
// normalizeRecord refuses a bad `skipReason` / `findings` with `bad skipReason` / `bad findings`;
// readRecords does not normalize, so older rows stay readable.
//
// Usage:
//   node telemetry.mjs append '<json>'      # append one record (validates + stamps ts)
//   node telemetry.mjs append @rec.json      # ...from a file
//   node telemetry.mjs append -              # ...from stdin
//   node telemetry.mjs report [--since ISO] [--min-sample N]
//                                            # print leading indicators (JSON + table), in total, by complexity and by repo;
//                                            # a repo under N reached rows (positive integer, default 20, else exit 2) shows its count, no rates
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
//                                            # records (T-retro-approval instead reads the `retro` context field, the
//                                            # retro records outside that window): tripped, holding, insufficient-data
//                                            # or pending-instrumentation, with past-due review dates; T-escapes
//                                            # reads a saved `escapes` run (--escapes), never GitHub, and T-coverage
//                                            # runs `audit` per run family
//   node telemetry.mjs run-id [--label L]    # print $SHIP_DAG_RUN_ID, else a freshly minted run id
//
// Path resolution: $SHIP_DAG_TELEMETRY, else $XDG_STATE_HOME/ship-dag/runs.jsonl,
// else ~/.local/state/ship-dag/runs.jsonl.

import { appendFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readArg } from './lib/read-arg.mjs';
import { mean, rate, groupBy } from './lib/stats.mjs';
import { isMain } from './lib/is-main.mjs';
import { ENGINE_DIED, INFRA_REASONS, RESOURCE_ROUTE, ranOf, SKIP_REASON_DEPENDENCY } from './lib/failure.mjs';
import { mintRunId, runIdFromConfigName, sameRun } from './lib/run-id.mjs';
import { implementCost, isCount, isUsd } from './lib/transcript-cost.mjs';
import { deriveWaveRecords, markerDeathOf, rowCovered, TERMINAL, WaveRefusal } from './lib/wave-records.mjs';
import { formatRef, groupByRepo, isPr, issueKey, parseRef, refKey, repoSpellings, sameRepo } from './lib/ref.mjs';
import { configDirs, readWaveReport, readWaveReports, reportOwnership, runFamilyDirs, runFamilyStateDirs, waveContextFor } from './lib/wave-reports.mjs';
import { readSidecar, SIDECAR_NAME, waveConfigs } from './lib/wave-sidecar.mjs';
import { defaultBaseDir } from './rate-limit-preflight.mjs';
import { latestByRef, outcomeOf } from './lib/log-order.mjs';
import { reviewRoundFiles } from './lib/review-rounds.mjs';
import { CATEGORIES } from './review-gate.mjs';
import { isFindingObject } from './lib/finding.mjs';
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
const FAILURE_REASONS = new Set([...INFRA_REASONS, null]);
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
  // ran (the report row's own fact, on a derived record) separates one report's event from the earlier one it re-lists.
  if (rec.ran != null && typeof rec.ran !== 'boolean') throw new Error(`bad ran: ${JSON.stringify(rec.ran)}`);
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
  if (rec.skipReason != null && rec.skipReason !== SKIP_REASON_DEPENDENCY) throw new Error(`bad skipReason: ${JSON.stringify(rec.skipReason)}`);
  if (rec.findings != null && !Array.isArray(rec.findings)) throw new Error(`bad findings: not an array: ${JSON.stringify(rec.findings)}`);
  const badFinding = (rec.findings ?? []).findIndex((f) => typeof f !== 'string' && !isFindingObject(f));
  if (badFinding >= 0) throw new Error(`bad findings: entry ${badFinding} is ${JSON.stringify(rec.findings[badFinding])}`);
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
 * tallied separately in `quotaFailures`. So is an engine stop (`RESOURCE_STOPS`:
 * memory-critical, lease-wait) or an engine death (engine-died), together `RESOURCE_ROUTE`, tallied in `resourceStops`.
 * kind:"retro" records are excluded from every per-issue indicator (they are
 * pass-scoped, not issue-scoped) and aggregated into their own `retro` section.
 * `byRepo` groups the same population by repo (casing folded by `sameRepo`, keyed as first written); a repo with
 * fewer than `minSample` reached rows carries `n` and no rates. Each entry splits yield and review catch by tier (a tier
 * under `minSample` keeps `n` only), counts the `isFindingObject` `findings` of its blocking rows by category in `findingCategories`
 * (a null category as `(blank)`, one outside `CATEGORIES` as `(other)`) and the blocking rows with none (a string, a legacy object or no `findings`) in `unstructured`.
 * `issues` counts distinct issues (`latestByRef`, casing folded), those merged in the window, the mean non-infra rows
 * that reached implement per merged issue (`null` with none), and those whose latest record is no merge and no maintainer deferral. A
 * deferral with an infra reason (`INFRA_REASONS`: an engine death, a lease-wait, memory-critical or rate-limited stop)
 * is the engine's, not a maintainer's, so it is unresolved, as is a point-F deferral of an engine-died ref (its reason
 * is kept), as is an engine skip (`skipReason`); an unmarked deferral is a maintainer's.
 * `legacyDeath` is not read: the historical rows stay model errors here.
 */
export function report(records, { minSample = 20 } = {}) {
  const issues = records.filter((r) => r.kind !== 'retro');
  const retros = records.filter((r) => r.kind === 'retro');
  // A failureReason: "rate-limited" record is an infra death (the wrapper's
  // wait/resume cycle killed the attempt), not a model-quality signal. Exclude
  // it from the model-quality population — first-pass yield (and its
  // byComplexity breakdown), triage-miss, bounce rate, review-catch — so a
  // quota outage never dilutes those; it's counted instead in quotaFailures.
  const quotaFailures = issues.filter((r) => r.failureReason === 'rate-limited');
  const resourceStops = issues.filter((r) => RESOURCE_ROUTE.has(r.failureReason));
  const modelIssues = issues.filter((r) => !INFRA_REASONS.has(r.failureReason));
  const reached = modelIssues.filter((r) => r.implStatus != null);
  const cleared = modelIssues.filter((r) => r.triageStatus === 'clear');
  const yieldOf = (rs) => {
    const pass = rs.filter((r) => r.finalState === 'merged' && (r.bounces ?? 0) === 0).length;
    return { reached: rs.length, pass, rate: rs.length ? pass / rs.length : 0 };
  };
  const byComplexity = {};
  const g = groupBy((r) => r.complexity, reached);
  for (const tier of TIERS) byComplexity[tier] = yieldOf(g.get(tier) || []);
  const missOf = (rs) => rs.filter((r) => r.implStatus === 'blocked' || r.reviewVerdict === 'blocking').length;
  const blockingOf = (rs) => rs.filter((r) => r.reviewVerdict === 'blocking').length;
  const miss = missOf(cleared);
  const blocking = blockingOf(reached);
  const byRepo = {};
  const clearedByRepo = groupByRepo(records, cleared);
  for (const [repo, rs] of groupByRepo(records, reached)) {
    const clearedHere = clearedByRepo.get(repo) ?? [];
    const tiers = groupBy((r) => r.complexity, rs);
    const tierOf = (tier) => {
      const t = tiers.get(tier) ?? [];
      return t.length < minSample ? { n: t.length } : { n: t.length, firstPassYield: yieldOf(t), reviewCatch: { reached: t.length, blocking: blockingOf(t), rate: blockingOf(t) / t.length } };
    };
    const findingCategories = {};
    let unstructured = 0;
    for (const r of rs.filter((x) => x.reviewVerdict === 'blocking')) {
      const objs = (r.findings ?? []).filter(isFindingObject);
      if (!objs.length) unstructured++;
      for (const { category } of objs) {
        const key = category == null ? '(blank)' : CATEGORIES.includes(category) ? category : '(other)';
        findingCategories[key] = (findingCategories[key] ?? 0) + 1;
      }
    }
    byRepo[repo] = rs.length < minSample ? { n: rs.length } : {
      n: rs.length,
      firstPassYield: yieldOf(rs),
      byComplexity: Object.fromEntries(TIERS.map((tier) => [tier, tierOf(tier)])),
      findingCategories,
      unstructured,
      reviewCatch: { reached: rs.length, blocking: blockingOf(rs), rate: blockingOf(rs) / rs.length },
      triageMiss: { cleared: clearedHere.length, miss: missOf(clearedHere), rate: clearedHere.length ? missOf(clearedHere) / clearedHere.length : 0 },
    };
  }
  const latest = latestByRef(records);
  const attempts = groupBy(issueKey, reached);
  const mergedKeys = new Set(issues.filter((r) => r.finalState === 'merged').map(issueKey));
  const unresolved = [...latest.values()].filter((r) => !['merged', 'maintainer-deferred'].includes(outcomeOf(r)));
  const issueOutcomes = {
    distinct: latest.size,
    merged: mergedKeys.size,
    unresolved: unresolved.length,
    attemptsPerMerged: mergedKeys.size ? mean([...mergedKeys].map((k) => (attempts.get(k) ?? []).length)) : null,
  };
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
    resourceStops: resourceStops.length,
    firstPassYield: yieldOf(reached),
    byComplexity,
    byRepo,
    issues: issueOutcomes,
    minSample,
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
  if (rep.resourceStops > 0) lines.push(`resource stops:    ${rep.resourceStops}`);
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
  const i = rep.issues;
  lines.push(`issues:            ${i.distinct} distinct, ${i.merged} merged, ${i.unresolved} unresolved, ${i.attemptsPerMerged == null ? '—' : i.attemptsPerMerged.toFixed(2)} attempts per merged`);
  // Gated on a non-empty byRepo so a log with no rows reached renders as before.
  const repos = Object.entries(rep.byRepo ?? {}).sort(([, a], [, b]) => b.n - a.n);
  if (repos.length) {
    const yieldCell = (y) => `${y.pass}/${y.reached} (${pct(y.rate)})`;
    const table = [['by repo:', 'reached', 'yield', 'review-catch', 'triage-miss', ...TIERS]];
    for (const [repo, e] of repos) {
      table.push(e.firstPassYield
        ? [`  ${repo}`, `${e.n}`, yieldCell(e.firstPassYield), pct(e.reviewCatch.rate), pct(e.triageMiss.rate), ...TIERS.map((t) => e.byComplexity[t].firstPassYield ? yieldCell(e.byComplexity[t].firstPassYield) : `n=${e.byComplexity[t].n}`)]
        : [`  ${repo}`, `${e.n}`, `n<${rep.minSample}`]);
    }
    const widths = table[0].map((_, c) => Math.max(...table.map((r) => (r[c] ?? '').length)));
    table.forEach((r) => lines.push(r.map((c, k) => c.padEnd(widths[k])).join('  ').trimEnd()));
  }
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
 * state dir alone, with a warning, when the dir holding the family cannot be listed (`runFamilyStateDirs`, the scope rule diagnose-failure shares). Appends are
 * best-effort: a failed one is warned about and the rest continue.
 * @param {string} reportPath
 * @param {Record<string, object>} outcomes per-ref `{pr, hitl:{pointB}, finalState, bounces, findings, tokens, pressureOverride}`
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
  const family = runFamilyStateDirs(stateDir, { warn: (m) => warn(`ingest-wave: ${m}`), runId: entry?.runId || runIdFromConfigName(report.configName) });
  const familyReports = family.flatMap((d) => (d === stateDir ? reports : readWaveReports(d, { warn: () => {} })));
  const ownership = reportOwnership(familyReports);
  const { inWave, digests } = waveWindow(stateDir, own, familyReports, ownership, warn);

  const rounds = {};
  for (const ref of refs) {
    rounds[ref] = reviewRoundFiles(family.map((d) => join(d, 'reviews')), ref)
      .map(({ path, mtimeMs }) => {
        let review = null;
        try { review = JSON.parse(readFileSync(path, 'utf8')); } catch { /* an unparseable round is kept as null, windowed by mtime */ }
        return inWave(ref, mtimeMs, review?.meta?.reportId, path) && { path, review };
      })
      .filter(Boolean);
  }

  // Read outside the try below: an unreadable log is not a malformed report.
  const existing = readRecords(path);
  let records;
  try {
    // A sidecar entry carries its wave's tuningVersion; a wave without one ran before the sidecar
    // did, and epic #64 reads a missing version as 0, never as today's.
    ({ records } = deriveWaveRecords(report, entry, digests, rounds, outcomes, {
      existing, warn, tuningVersion: 0, reportId: basename(file, '.json'), earlier: ownership.earlierOf(own), later: ownership.laterOf(own),
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
  // A row with no record, a skipped one (implStatus null: it never reached implement) or one that launched no session
  // (`ran` false) leaves its sessions for the ref's next record, and a row that lists `sessionIds` takes only those; a session an earlier record of the run family lists, in the
  // log or earlier in this wave (a point-E row derives a death and an outcome), is not counted again.
  const taken = [];
  for (const rec of records) {
    if (rec.implStatus === null || rec.ran === false) continue;
    // The engine named the log from the row's ref as written, so find that row, as written, rather than rebuild it.
    const ref = refs.find((r) => { const p = parseRef(r); return p?.repo === rec.repo && p.number === rec.issue; });
    const row = report.issues.find((r) => r.ref === ref);
    // A marker's death is an earlier run's: the sessions the row lists, or its transcript holds, are its continuation's.
    if (markerDeathOf(row)(rec)) continue;
    const counted = [...existing, ...taken].filter((e) => sameRepo(e.repo, rec.repo) && e.issue === rec.issue && sameRun(e.runId, rec.runId)).flatMap((e) => e.cost?.implement?.sessionIds ?? []);
    const implement = implementCost(logPathForRef(stateDir, ref), counted, warn, row.sessionIds);
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
 * A digest the engine stamped with a report id (`reportId`), or a review round the Review subagent stamped with one
 * (`meta.reportId`), belongs to that report's wave and no other, whatever its mtime: a late round (a resume, or a
 * point-E continuation) and a copy that lost mtimes keep their wave. Which wave a round belongs to is all the stamp
 * decides: `reviewRoundFiles` orders a ref's rounds. A stamp that names no report of `familyReports` (a typo, an
 * unsubstituted placeholder, a filename) is warned about and, like an unstamped digest or round (written before
 * stamping), keeps the mtime window below; so does a stamp that names a report of `familyReports` which does not list
 * the ref, because that report's ingest never reads the ref's rounds. A report lists a ref only by a row that is its own event, not
 * one it `carriedOver` from an earlier report, since it derives no record for that row either.
 * A digest or review round belongs to this wave when it was written after this report started and
 * before the next report that re-ran the ref did: a retry or a later wave rewrites the ref's digest
 * and re-reviews it. A later row that carries `ran` re-ran it unless it is `carriedOver` (a `ran: false` row of its own, a retry's pre-launch failure, does end it); without `ran`, one that lists the ref with a different PR re-ran it. A report that only carries the row over with the same PR (a --retry-failed
 * run of other rows) re-runs nothing, so later rounds still review this row's PR. A later report
 * refused for a malformed row still started when it says, so it still ends the window.
 * `ownership` is `reportOwnership(familyReports)`: whether a row is its report's own event is its `owns`, and which refs a report lists is its `listing`.
 * @returns {{inWave: (ref: string, mtimeMs: number, reportId: unknown, path: string) => boolean, digests: Record<string, object>}}
 *   `inWave` names `path` in its warning; `digests` by ref,
 *   for the rows that did not succeed (deriveWaveRecords records only terminal rows and ignores a succeeded row's stale digest)
 */
function waveWindow(stateDir, { report, startedAt, id }, familyReports, { owns, listing: listed }, warn) {
  const others = familyReports.filter((r) => Number.isFinite(r.startedAt) && r.startedAt > startedAt);
  const reran = (later, row) => later.report.issues.some((r) => r?.ref === row.ref && (ranOf(r) == null ? !(isPr(row.prNumber) && r.prNumber === row.prNumber) : owns(later, r)));
  const ends = Object.fromEntries(report.issues.map((row) => [row.ref, Math.min(Infinity, ...others.filter((rep) => reran(rep, row)).map((rep) => rep.startedAt))]));
  const inWave = (ref, mtimeMs, reportId, path) => {
    if (listed.get(reportId)?.has(ref)) return reportId === id;
    if (listed.has(reportId)) warn(`${path}: stamped with report id ${JSON.stringify(reportId)}, which names no report of this run that lists ${ref}; windowed by mtime`);
    else if (typeof reportId === 'string') warn(`${path}: stamped with report id ${JSON.stringify(reportId)}, which names no report of this run; windowed by mtime`);
    return mtimeMs >= startedAt && mtimeMs < ends[ref];
  };
  const digests = {};
  for (const r of report.issues.filter((i) => ['failed', 'blocked', 'skipped'].includes(i?.status))) {
    const p = digestPathForRef(stateDir, r.ref);
    let mtimeMs;
    try { ({ mtimeMs } = statSync(p)); } catch { continue; }
    let digest;
    try { digest = JSON.parse(readFileSync(p, 'utf8')); } catch (err) { digest = err; }
    if (!inWave(r.ref, mtimeMs, digest?.reportId, p)) { warn(`${p}: written outside this wave; ignored`); continue; }
    if (digest instanceof Error) { warn(`${p}: unreadable digest (${digest.message}); ignored`); continue; }
    digests[r.ref] = digest;
  }
  return { inWave, digests };
}

/**
 * Audit a run family against the log. Every dir of `runFamilyDirs(runId, baseDir)` is read for its
 * reports; a readable one with a terminal row `rowCovered` finds no record for (handed the row's digest as
 * `waveWindow` reads it for ingest) is `notIngested`, as is a terminal row listing an `engineDeaths` marker no record holds (`rowCovered`'s marker check)
 * (`{dir, id, source (where its routing label came from), refs (the uncovered rows')}`; one with no
 * terminal row is not named), and one with an `error` is `unreadable` (`{path, error}`). `terminalRows`
 * is the number of terminal rows examined (a row a retry carries over counts once per report that lists it,
 * as `notIngested` names it) and `prRows` those with a PR, `{total, uncovered}`: the denominators for a coverage share. `engineDied` names the refs
 * whose latest record by `ts` (refs compared case-insensitively) is an engine death (`failureReason: "engine-died"`), with no later outcome. A sidecar
 * entry or config file (in either of `configDirs`) that no readable report matched is `neverReported`:
 * there is no report to ingest. That is a wave the engine died in before it wrote one, but also a wave
 * still running, an earlier emit of a ref set whose re-emit a report matched, and an `unreadable` report's.
 * @param {string} runId
 * @param {{baseDir?: string, records?: object[], warn?: (m: string) => void}} [opts] `records` is the telemetry log
 * @throws when no dir under `baseDir` belongs to the run family, so a mistyped id does not read as all clear
 */
export function audit(runId, { baseDir = defaultBaseDir(), records = readRecords(telemetryPath()), warn = (m) => console.error(m) } = {}) {
  const out = { runId, dirs: runFamilyDirs(runId, baseDir), terminalRows: 0, prRows: { total: 0, uncovered: 0 }, engineDied: [], notIngested: [], unreadable: [], neverReported: { sidecar: [], configs: [] } };
  if (!out.dirs.length) throw new Error(`no dir under ${baseDir} belongs to run ${runId}`);
  const logged = records.filter((r) => sameRun(r.runId, runId));
  // Quiet: an unreadable report is named in `unreadable`, so it is not warned about as well.
  const reads = out.dirs.map((dir) => readWaveReports(dir, { warn: () => {} }));
  const family = reads.flat();
  const ownership = reportOwnership(family);
  // Family-wide: a remote host's collected dir matches the sidecar lines and configs in its wave dir (`waveContextFor`).
  const matched = new Set();
  for (const [i, dir] of out.dirs.entries()) {
    for (const read of reads[i]) {
      if (read.error) { out.unreadable.push({ path: read.path, error: read.error }); continue; }
      // Quiet: the sidecar is read once more below, so a torn line is warned about once per dir, not per report.
      const { entry, configFile, source } = waveContextFor(dir, read, { warn: () => {} });
      if (source === 'sidecar') matched.add(JSON.stringify(entry));
      if (configFile) matched.add(configFile);
      // Quiet: a digest outside the window, or unreadable, is ingest's to warn about.
      const { digests } = waveWindow(dir, read, family, ownership, () => {});
      const terminal = read.report.issues.filter((r) => TERMINAL.has(r?.status));
      const [earlier, later] = [ownership.earlierOf(read), ownership.laterOf(read)];
      const uncovered = terminal.filter((r) => !rowCovered(r, read, logged, runId, digests[r.ref], earlier, later));
      out.terminalRows += terminal.length;
      out.prRows.total += terminal.filter((r) => isPr(r.prNumber)).length;
      out.prRows.uncovered += uncovered.filter((r) => isPr(r.prNumber)).length;
      const refs = uncovered.map((r) => r.ref);
      if (refs.length) out.notIngested.push({ dir, id: read.id, source, refs });
    }
  }
  for (const dir of out.dirs) {
    for (const e of readSidecar(join(dir, SIDECAR_NAME), { warn })) {
      if (!matched.has(JSON.stringify(e))) out.neverReported.sidecar.push({ dir, refs: (e.issues ?? []).map((i) => i?.ref) });
    }
    for (const { configFile } of configDirs(dir).flatMap((d) => waveConfigs(d))) if (!matched.has(configFile)) out.neverReported.configs.push(configFile);
  }
  // A ref's latest record (by ts; a later ingest can append an earlier event) is its outcome so far: an engine death
  // nothing followed was never resumed into the log. The death is its deferral with implStatus "error"; an outcome
  // that keeps the reason (a point-F hold) is not. A ref deferred at point F stays named: its deferral is the death.
  const last = latestByRef(logged);
  const spelled = repoSpellings(records);
  out.engineDied = [...last.values()].filter((r) => outcomeOf(r) === ENGINE_DIED).map((r) => formatRef(spelled.get(refKey(r.repo)), r.issue));
  return out;
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
    let minSample = 20;
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '--since') {
        since = rest[++i];
        if (!since) { process.stderr.write('--since requires an ISO timestamp\n'); process.exit(2); }
      }
      if (rest[i] === '--min-sample') {
        minSample = Number(rest[++i]);
        if (!Number.isInteger(minSample) || minSample < 1) { process.stderr.write('--min-sample requires a positive integer\n'); process.exit(2); }
      }
    }
    let records = readRecords(telemetryPath());
    if (since) records = records.filter((r) => r.ts >= since);
    const rep = report(records, { minSample });
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
