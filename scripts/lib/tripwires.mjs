// tripwires.mjs — evaluate each decision's tripwire (references/tripwires.json) against the telemetry log.
//
// A tripwire is a data row naming its `metric`, which picks the evaluator below, its `source` field, its `trips`
// threshold and its `minSample`. Each evaluator returns a `state`: `tripped`, `holding`, `insufficient-data`, or
// `pending-instrumentation` (no record in the window carries the source field yet: shown, never an error). A
// tripwire trips only when the whole interval clears its threshold (Wilson for shares, a seeded bootstrap for a
// mean). The window is the records of the current `tuningVersion` (a missing one is 0); the log is read by the caller
// and `gh` is never called: T-escapes takes a saved `telemetry.mjs escapes` run.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sameRun } from './run-id.mjs';
import { bootstrapCI, groupBy, mean, wilson } from './stats.mjs';

export const TRIPWIRES_PATH = fileURLToPath(new URL('../../references/tripwires.json', import.meta.url));
/** The states, worst first: the order a tripwire made of several parts reports its worst. */
export const STATES = ['tripped', 'holding', 'insufficient-data', 'pending-instrumentation'];
const DAY = 86_400_000;

export const loadTripwires = (path = TRIPWIRES_PATH) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * What the evaluators read: the issue records (`records`), those of `version` (`window`), the epoch ms `now`, a
 * saved `escapes` run, and `audit(runId)`, which returns `telemetry.mjs audit`'s result or throws for a run with no engine dir.
 */
export function tripwireContext(records, { version, now = Date.now(), escapes, audit } = {}) {
  const issues = records.filter((r) => r.kind !== 'retro');
  return { records: issues, window: issues.filter((r) => ver(r) === version), version, now, escapes, audit };
}

const ver = (r) => r.tuningVersion ?? 0;
const at = (r, path) => path.split('.').reduce((v, k) => v?.[k], r);
const isPr = (r) => r.finalState === 'merged' && r.pr != null;
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
  const prs = window.filter(isPr);
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
    const pairs = have.filter((r) => r.scopedMiss != null);
    const misses = pairs.reduce((s, r) => s + r.scopedMiss, 0);
    return { state: pairs.length < t.minSample ? 'insufficient-data' : misses >= t.trips.atLeast ? 'tripped' : 'holding', pairs: pairs.length, misses };
  }),

  reach: (t, ctx) => gated(t, ctx, (have) => {
    const rs = have.filter((r) => r.reach === 'in-diff');
    const sum = (k) => rs.reduce((s, r) => s + (r.exploreOutsideDiff?.[k] ?? 0), 0);
    return share(sum('outside'), sum('total'), t.trips, t.minSample, rs.length);
  }),

  fallback: (t, { window, now }) => {
    const month = window.filter((r) => Date.parse(r.ts) >= now - 30 * DAY);
    return share(month.filter((r) => r.path === 'workflow').length, month.length, t.trips, t.minSample);
  },

  // A backfilled earlier report can absorb a later re-run's sessions until #107 lands (PR #103 `## Deferred`), so a version's mean can read low.
  cost: (t, ctx) => gated(t, ctx, () => {
    const used = ctx.records.filter((r) => isPr(r) && r.reportId && typeof at(r, t.source) === 'number');
    const first = (rs) => [...rs].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).slice(0, t.minSample).map((r) => at(r, t.source));
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
  coverage: (t, ctx) => {
    const families = [];
    for (const r of ctx.records) if (!families.some((f) => sameRun(f, r.runId))) families.push(r.runId);
    const rows = { covered: 0, total: 0, prCovered: 0, prTotal: 0 };
    let skipped = 0;
    const fams = families.map((runId) => {
      if (!t.since || !ctx.window.some((r) => sameRun(r.runId, runId) && r.ts >= t.since)) return { runId, state: 'insufficient-data', reason: 'before the window' };
      let a;
      try { a = ctx.audit(runId); } catch { skipped += 1; return null; } // no engine dir: neither tripped nor holding
      const covered = a.terminalRows - a.notIngested.reduce((s, w) => s + w.refs.length, 0);
      rows.covered += covered; rows.total += a.terminalRows;
      rows.prCovered += a.prRows.total - a.prRows.uncovered; rows.prTotal += a.prRows.total;
      return { runId, ...share(covered, a.terminalRows, t.trips.rows, t.minSample) };
    }).filter(Boolean);
    // Inside the window only: a record from before cost.implement landed (mid-version) reached implement with none, and would read as an ingestion gap.
    const reached = ctx.window.filter((r) => t.since && r.ts >= t.since && r.reportId && r.implStatus != null);
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
