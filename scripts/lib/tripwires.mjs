// tripwires.mjs — evaluate each decision's tripwire (references/tripwires.json) against the telemetry log.
//
// A tripwire is a data row naming its `metric`, which picks the evaluator below, its `source` field, its `trips`
// threshold and its `minSample`. Each evaluator returns a `state`: `tripped`, `holding`, `insufficient-data`, or
// `pending-instrumentation` (no record in the window carries the source field yet: shown, never an error). A
// tripwire trips only when the whole interval clears its threshold (Wilson for shares, a seeded bootstrap for a
// mean). The window is the records of the current `tuningVersion` (a missing one is 0), except that T-retro-approval reads the retro records (`ctx.retro`), newest first, outside it; the log is read by the caller
// and `gh` is never called: T-escapes takes a saved `telemetry.mjs escapes` run.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { byTs, isIssueRecord } from './log-order.mjs';
import { parsePr } from './ref.mjs';
import { sameRun } from './run-id.mjs';
import { bootstrapCI, groupBy, mean, wilson } from './stats.mjs';

export const TRIPWIRES_PATH = fileURLToPath(new URL('../../references/tripwires.json', import.meta.url));
/** The states, worst first: the order a tripwire made of several parts reports its worst. */
export const STATES = ['tripped', 'holding', 'insufficient-data', 'pending-instrumentation'];
const DAY = 86_400_000;
/** Whether record `r` falls on or after tripwire `t`'s `since`, compared as times (a timestamp's spelling, with or without milliseconds, does not matter; an unparseable one is outside). */
const inWindow = (r, t) => Boolean(t.since) && Date.parse(r.ts) >= Date.parse(t.since);
/** `telemetry.mjs audit`'s refusal for a run family with no engine dir: the one audit error T-coverage skips. */
export const NO_ENGINE_DIR = /^no dir under .* belongs to run /;

export const loadTripwires = (path = TRIPWIRES_PATH) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * What the evaluators read: the issue records (`records`), those of `version` (`window`), the `kind: retro` records (`retro`, outside the version window), the epoch ms `now`, a
 * saved `escapes` run, and `audit(runId)`, which returns `telemetry.mjs audit`'s result or throws for a run with no engine dir.
 */
export function tripwireContext(records, { version, now = Date.now(), escapes, audit } = {}) {
  const issues = records.filter(isIssueRecord);
  return { records: issues, window: issues.filter((r) => ver(r) === version), retro: records.filter((r) => r.kind === 'retro'), version, now, escapes, audit };
}

/** Retro keys from before the canonical counts: a record that carries one has counts `normalizeRetroRecord` zero-filled, so it is no sample. */
const LEGACY_RETRO = ['refactorsProposed', 'adjustmentsProposed', 'proposedPlanAdjustments', 'approvedAll'];
const ver = (r) => r.tuningVersion ?? 0;
const at = (r, path) => path.split('.').reduce((v, k) => v?.[k], r);
/** A merged record whose `pr` parsePr reads (ref.mjs's `isPr` tests a bare number). */
const mergedPr = (r) => r.finalState === 'merged' && parsePr(r.pr, r.repo) != null;
// ingest-wave writes complexitySource "default" when the routing named no complexity and "normal" was assumed: a per-tier metric cannot count it.
const known = (r) => r.complexitySource !== 'default';
const worst = (parts) => STATES.find((s) => parts.some((p) => p.state === s)) ?? 'insufficient-data';
const clears = (ci, trips) => ci.hi < (trips.upperBelow ?? -Infinity) || ci.lo > (trips.lowerAbove ?? Infinity);

/** `k` of `n` judged against `trips`; fewer than `min` samples (default `n`) is insufficient-data. */
function share(k, n, trips, min, sample = n) {
  if (sample < min) return { state: 'insufficient-data', k, n };
  const ci = wilson(k, n);
  return { state: clears(ci, trips) ? 'tripped' : 'holding', k, n, rate: n ? k / n : 0, ...ci };
}

/** `fn` over the merged PRs that carry `t.source`, with the coverage share; pending-instrumentation when none does. */
function gated(t, { window }, fn) {
  const prs = window.filter(mergedPr);
  const have = prs.filter((r) => at(r, t.source) !== undefined);
  if (!have.length) return { state: 'pending-instrumentation', source: t.source };
  return { ...fn(have), coverage: { have: have.length, of: prs.length } };
}

/** `f(records, tier)` per tier of the records with a known tier, the worst state, and how many were dropped for an assumed one. */
function byTier(rs, f) {
  const tiers = Object.fromEntries([...groupBy((r) => r.complexity, rs.filter(known))].map(([tier, xs]) => [tier, f(xs, tier)]));
  return { state: worst(Object.values(tiers)), tiers, dropped: rs.filter((r) => !known(r)).length };
}

const EVALUATORS = {
  'explore-unique': (t, ctx) => gated(t, ctx, (have) => byTier(have, (xs) => share(xs.filter((r) => at(r, t.source) >= 1).length, xs.length, t.trips, t.minSample))),

  scoped: (t, ctx) => gated(t, ctx, (have) => {
    const pairs = have.filter((r) => at(r, t.source) != null);
    const misses = pairs.reduce((s, r) => s + at(r, t.source), 0);
    return { state: pairs.length < t.minSample ? 'insufficient-data' : misses >= t.trips.atLeast ? 'tripped' : 'holding', pairs: pairs.length, misses };
  }),

  reach: (t, ctx) => gated(t, ctx, (have) => {
    // A null value is a failed files fetch (W5): instrumented, but not a sample.
    const rs = have.filter((r) => r.reach === 'in-diff' && at(r, t.source) != null);
    const sum = (k) => rs.reduce((s, r) => s + (at(r, t.source)[k] ?? 0), 0);
    return share(sum('outside'), sum('total'), t.trips, t.minSample, rs.length);
  }),

  fallback: (t, { window, now }) => {
    const month = window.filter((r) => Date.parse(r.ts) >= now - 30 * DAY);
    return share(month.filter((r) => r.path === 'workflow').length, month.length, t.trips, t.minSample);
  },

  // Not tuning-versioned (a retro record carries no tuningVersion): the newest records, taken whole, until their proposals reach minSample.
  'retro-approval': (t, { retro }) => {
    const newest = retro.filter((r) => !LEGACY_RETRO.some((key) => key in r)).sort((a, b) => byTs(b, a));
    let [k, n, records] = [0, 0, 0];
    for (const r of newest) {
      if (n >= t.minSample) break;
      n += r.proposedRefactors + r.proposedAdjustments;
      k += r.approvedRefactors + r.approvedAdjustments;
      records += 1;
    }
    return { ...share(k, n, t.trips, t.minSample), records };
  },

  // A backfilled earlier report whose row lists no `sessionIds` can still absorb a later re-run's sessions, so a version's mean can read low.
  cost: (t, ctx) => gated(t, ctx, () => {
    const used = ctx.records.filter((r) => mergedPr(r) && r.reportId && typeof at(r, t.source) === 'number');
    const first = (rs) => [...rs].sort(byTs).slice(0, t.minSample).map((r) => at(r, t.source));
    return byTier(used.filter((r) => ver(r) === ctx.version), (xs, tier) => {
      const earlier = used.filter((r) => known(r) && r.complexity === tier && ver(r) < ctx.version);
      const baselineVersion = Math.max(...earlier.map(ver));
      const [now, base] = [first(xs), first(earlier.filter((r) => ver(r) === baselineVersion))];
      if (now.length < t.minSample || base.length < t.minSample) return { state: 'insufficient-data', n: now.length, baselineN: base.length };
      const ci = bootstrapCI(now);
      return { state: ci.lo > t.trips.ratioAbove * mean(base) ? 'tripped' : 'holding', mean: ci.mean, lo: ci.lo, hi: ci.hi, baselineMean: mean(base), baselineVersion };
    });
  }),

  // Takes `escapeReport`'s JSON as injected (`--escapes <file>`), never GitHub. `escapeReport` keys a record with no tuningVersion "0".
  escapes: (t, { escapes, version }) => {
    if (!escapes) return { state: 'insufficient-data', hint: 'run telemetry.mjs escapes > <file> and pass --escapes <file>' };
    const by = escapes.byTuningVersion ?? {};
    const cur = by[String(version)];
    const base = Object.entries(by).filter(([v]) => Number(v) < t.baseline.beforeVersion).reduce((a, [, x]) => ({ prs: a.prs + x.prs, escaped: a.escaped + x.escaped }), { prs: 0, escaped: 0 });
    if (version < t.baseline.beforeVersion) return { state: 'insufficient-data', hint: `the baseline (versions before ${t.baseline.beforeVersion}) is still being collected` };
    if (!cur || cur.prs < t.minSample || !base.prs) return { state: 'insufficient-data', prs: cur?.prs ?? 0 };
    const [ci, bci] = [wilson(cur.escaped, cur.prs), wilson(base.escaped, base.prs)];
    return {
      state: ci.lo > bci.hi ? 'tripped' : 'holding', prs: cur.prs, escaped: cur.escaped, rate: cur.escaped / cur.prs, ...ci,
      strong: cur.strong, strongRate: cur.strongRate, baseline: { ...base, ...bci },
    };
  },

  // Reads `audit`'s terminalRows rather than walking the reports again, and never calls rowCovered (it needs each row's failure digest).
  // The window is family-granular: a family with any current-version record at or after `since` is audited whole, so a run
  // that spans `since` brings its earlier rows into the share too. A per-row cut would need audit to window its reports by date.
  coverage: (t, ctx) => {
    const families = [];
    for (const r of ctx.records) if (!families.some((f) => sameRun(f, r.runId))) families.push(r.runId);
    const rows = { covered: 0, total: 0, prCovered: 0, prTotal: 0 };
    let skipped = 0;
    const fams = families.map((runId) => {
      if (!t.since || !ctx.window.some((r) => sameRun(r.runId, runId) && inWindow(r, t))) return { runId, state: 'insufficient-data', reason: 'before the window' };
      let a;
      try { a = ctx.audit(runId); } catch (err) { // no engine dir: neither tripped nor holding; anything else is a real failure
        if (!NO_ENGINE_DIR.test(err?.message)) throw err;
        skipped += 1; return null;
      }
      const covered = a.terminalRows - a.notIngested.reduce((s, w) => s + w.refs.length, 0);
      rows.covered += covered; rows.total += a.terminalRows;
      rows.prCovered += a.prRows.total - a.prRows.uncovered; rows.prTotal += a.prRows.total;
      return { runId, ...share(covered, a.terminalRows, t.trips.rows, t.minSample) };
    }).filter(Boolean);
    // A ran-false record (a row that launched no session) never carries cost, so it is no ingestion gap and stays out of the share.
    // Inside the window only: a record from before cost.implement landed (mid-version) reached implement with none, and would read as an ingestion gap.
    const reached = ctx.window.filter((r) => inWindow(r, t) && r.reportId && r.ran !== false && r.implStatus != null);
    const withCost = reached.filter((r) => typeof at(r, t.source) === 'number');
    const cost = !t.since ? { state: 'insufficient-data', reason: 'no window date set' }
      : withCost.length ? share(withCost.length, reached.length, t.trips.cost, t.minSample) : { state: 'pending-instrumentation', source: t.source };
    return { state: worst([{ state: worst(fams) }, cost]), rows, families: fams, skipped, cost };
  },
};

/** Evaluate tripwire `t` (a row of tripwires.json): its metric's result, `reviewOverdue` when its review date is past, and its action. */
export function evaluate(t, ctx) {
  const ev = EVALUATORS[t.metric];
  if (!ev) throw new Error(`tripwires: no evaluator for metric "${t.metric}" (${t.id})`);
  const overdue = t.reviewDate && Date.parse(t.reviewDate) + DAY <= ctx.now;
  return { id: t.id, decision: t.decision, ...ev(t, ctx), ...(overdue && { reviewOverdue: t.reviewDate }), action: t.action };
}

/** Evaluate every tripwire of `table`; a metric id with no evaluator throws. */
export const evaluateAll = (table, ctx) => table.tripwires.map((t) => evaluate(t, ctx));
