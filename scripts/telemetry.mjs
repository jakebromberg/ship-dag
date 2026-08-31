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
//   node telemetry.mjs append '<json>'      # append one record (validates + stamps ts)
//   node telemetry.mjs append @rec.json      # ...from a file
//   node telemetry.mjs append -              # ...from stdin
//   node telemetry.mjs report [--since ISO]  # print leading indicators (JSON + table)
//
// Path resolution: $SHIP_DAG_TELEMETRY, else $XDG_STATE_HOME/ship-dag/runs.jsonl,
// else ~/.local/state/ship-dag/runs.jsonl.

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { mean, rate, groupBy } from './lib/stats.mjs';
import { isMain } from './lib/is-main.mjs';

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
  process.stderr.write('usage: telemetry.mjs <append|report> ...\n');
  process.exit(2);
}

// Only run the CLI when invoked directly, not when imported by the test.
if (isMain(import.meta.url)) main(process.argv.slice(2));
