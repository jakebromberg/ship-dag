// score.mjs — turn one harness raw result into a variant scorecard.
//
// The harness (eval/harness.js) returns RAW per-issue data — file sets,
// self-labels, per-mutant caught flags, and per-stage output-token deltas — and
// ALL scoring math lives here so it is pure and unit-testable while the driver
// that spawns agents is not. Three quality tracks plus cost:
//   - implement correctness: file-set Jaccard/precision/recall vs the gold merge
//   - first-pass yield:      self-labeled merged-without-bounce rate
//   - review recall:         fraction of seeded mutants the review model caught
//   - cost:                  Σ stage output-tokens × price, and $/merged-issue
// Run tests: node --test "skills/ship-dag/eval/**/*.test.mjs"

import { mean, rate, percentile, groupBy, tabulate } from '../../scripts/lib/stats.mjs';
import { setStats } from './jaccard.mjs';
import { costUSD, OUTPUT_USD_PER_MTOK } from '../prices.mjs';

const STAGES = ['triage', 'implement', 'review'];

// Ordered complexity scale, so a triage mis-tier can be scored as exact vs
// merely adjacent (mechanical↔normal↔complex is off-by-one; mechanical↔complex
// is a two-step miss).
const TIER_ORDER = { mechanical: 0, normal: 1, complex: 2 };

/** Implement-correctness track: file-set overlap vs the gold merge, by tier. */
export function scoreImplement(results) {
  const rows = results
    .filter((r) => r.implement)
    .map((r) => ({ tier: r.tier, ...setStats(r.implement.predFiles, r.implement.goldFiles) }));
  const j = rows.map((x) => x.jaccard);
  const byTier = {};
  for (const [tier, xs] of groupBy((x) => x.tier, rows)) {
    byTier[tier] = { n: xs.length, jaccardMean: mean(xs.map((x) => x.jaccard)) };
  }
  return {
    n: rows.length,
    jaccardMean: mean(j),
    jaccardP50: percentile(50, j),
    precisionMean: mean(rows.map((x) => x.precision)),
    recallMean: mean(rows.map((x) => x.recall)),
    byTier,
  };
}

/** First-pass-yield track: self-labeled merged-without-bounce over issues that reached review. */
export function scoreFirstPass(results) {
  const rows = results.filter((r) => r.firstPass).map((r) => ({ tier: r.tier, ...r.firstPass }));
  const reached = rows.filter((r) => r.verdict != null);
  const byTier = {};
  for (const [tier, xs] of groupBy((r) => r.tier, reached)) {
    byTier[tier] = { reached: xs.length, firstPassYield: rate((r) => r.verdict === 'merged' && !r.bounced, xs) };
  }
  return {
    n: rows.length,
    reached: reached.length,
    firstPassYield: rate((r) => r.verdict === 'merged' && !r.bounced, reached),
    bounceRate: rate((r) => r.bounced, reached),
    byTier,
  };
}

/**
 * Triage-quality track: does the triage model, reading ONLY the issue text,
 * predict the complexity the work turned out to be? The corpus `tier`
 * (complexityTier of the merged PR) is the ground-truth label — the decision-
 * relevant one, since the complexity score routes implement EFFORT. Reports
 * exact + adjacent (off-by-one on the ordered scale) accuracy, a confusion
 * matrix, and the routing (clear/needs-decision) distribution (secondary — no
 * gold routing label in the corpus; cross-model κ lives in the report step).
 */
export function scoreTriage(results) {
  const rows = results.filter((r) => r.triage && r.triage.complexity && r.tier);
  const n = rows.length;
  let exact = 0;
  let adjacent = 0;
  const confusion = {}; // gold tier -> { predicted tier -> count }
  for (const r of rows) {
    const gold = r.tier;
    const pred = r.triage.complexity;
    if (pred === gold) exact += 1;
    if (TIER_ORDER[pred] != null && TIER_ORDER[gold] != null && Math.abs(TIER_ORDER[pred] - TIER_ORDER[gold]) <= 1) adjacent += 1;
    confusion[gold] = confusion[gold] || {};
    confusion[gold][pred] = (confusion[gold][pred] || 0) + 1;
  }
  const routed = results.filter((r) => r.triage && r.triage.routing);
  return {
    n,
    complexityAccuracy: n ? exact / n : null,
    complexityAdjacentAccuracy: n ? adjacent / n : null,
    confusion,
    routingCounts: tabulate((r) => r.triage.routing, routed),
  };
}

/**
 * Review-recall track: fraction of VALID mutants the review model caught. The
 * headline is the TEST-GATED bucket (a suite actually failed → a genuine
 * defect); the parse-only bucket (Swift/SQL, no suite on the host) is reported
 * separately so it never dilutes the rigorous number. Also broken out by kind
 * and by tier.
 */
const isGated = (m) => m.bucket === 'gated' || m.testStatus === 'gated-failed';
const isParseOnly = (m) => m.bucket === 'parse-only' || m.testStatus === 'parse-only';
const bucketStats = (xs) => ({ n: xs.length, caught: xs.filter((m) => m.caught).length, recall: rate((m) => m.caught, xs) });

export function scoreReview(results) {
  const mutants = results
    .filter((r) => r.review && Array.isArray(r.review.mutants))
    .flatMap((r) => r.review.mutants)
    .filter((m) => m.valid !== false); // drop mutants that never seeded / didn't parse
  const byKind = {};
  for (const [kind, xs] of groupBy((m) => m.kind, mutants)) byKind[kind] = bucketStats(xs);
  const byTier = {};
  for (const [tier, xs] of groupBy((m) => m.tier, mutants)) byTier[tier] = bucketStats(xs);
  const gated = mutants.filter(isGated);
  const parseOnly = mutants.filter(isParseOnly);
  return {
    n: mutants.length,
    caught: mutants.filter((m) => m.caught).length,
    recall: rate((m) => m.caught, mutants),
    // Headline = gated; parse-only kept separate.
    nGated: gated.length,
    recallGated: rate((m) => m.caught, gated),
    nParseOnly: parseOnly.length,
    recallParseOnly: rate((m) => m.caught, parseOnly),
    byKind,
    byTier,
  };
}

/**
 * Cost track: attribute each stage's output-token delta at that stage's model
 * price. A null token count (budget unavailable) is skipped and flags
 * `tokensMissing`, so the total is an explicit LOWER BOUND rather than silently
 * zero. `perMergedUSD` divides by the self-labeled merged count.
 */
export function scoreCost(results, spec, prices = OUTPUT_USD_PER_MTOK) {
  const modelFor = {
    triage: spec?.triage?.model,
    implement: spec?.implement?.model,
    review: spec?.review?.model,
  };
  const byStage = { triage: 0, implement: 0, review: 0 };
  let tokensMissing = false;
  for (const r of results) {
    const tk = r.tokens || {};
    for (const stage of STAGES) {
      const tokens = tk[stage];
      const model = modelFor[stage];
      if (tokens == null || !model) {
        tokensMissing = true;
        continue;
      }
      byStage[stage] += costUSD(model, tokens, prices);
    }
  }
  const totalUSD = byStage.triage + byStage.implement + byStage.review;
  const merged = results.filter((r) => r.firstPass && r.firstPass.verdict === 'merged').length;
  return { totalUSD, byStage, merged, perMergedUSD: merged ? totalUSD / merged : null, tokensMissing };
}

/**
 * Assemble the full scorecard for one variant run. Collects warnings for the
 * conditions a reader must not miss: lower-bound cost, placeholder prices, and
 * an empty recall track.
 * @param {object} raw  harness output: { runId, variant, spec, prices?, results[] }
 */
export function buildScorecard(raw) {
  const results = raw.results || [];
  const warnings = [];
  const cost = scoreCost(results, raw.spec, raw.prices || OUTPUT_USD_PER_MTOK);
  if (cost.tokensMissing) warnings.push('cost is a LOWER BOUND: some stage token counts were null (budget unavailable)');
  if (raw.prices == null) warnings.push('cost uses the default rate table in prices.mjs (verify against current published prices)');
  const review = scoreReview(results);
  if (review.n === 0) warnings.push('review-recall track is empty: no valid seeded mutants');
  else if (review.nGated < 20) warnings.push(`review recall rests on a THIN test-gated bucket (n=${review.nGated}); read it as directional, not decisive`);
  const triage = scoreTriage(results);
  if (triage.n === 0) warnings.push('triage track is empty: no triage stage ran (harness produced no triage output)');
  return {
    runId: raw.runId,
    variant: raw.variant,
    spec: raw.spec,
    n: results.length,
    triage,
    implement: scoreImplement(results),
    firstPass: scoreFirstPass(results),
    review,
    cost,
    warnings,
  };
}
