#!/usr/bin/env node
// report.mjs — compare variant replays on the cost/quality frontier.
//
// Ingests the RAW harness outputs (one JSON per variant; the first is the
// reference, usually `current`) and, because every variant judged the identical
// frozen bank and the same issues, produces PAIRED comparisons:
//   - review recall: paired McNemar over the common test-gated mutants
//   - implement:     bootstrap CI of the per-issue paired Jaccard difference
//   - cost:          per-stage $ and $/merged, side by side
//
// All statistics live in tested pure modules (stats.mjs, lib/score.mjs,
// lib/jaccard.mjs); this file only pairs, calls them, and formats — so its own
// helpers are pure and unit-tested, and it holds no inline math.
//
// Usage: node eval/report.mjs current.raw.json sonnet-review.raw.json [more.raw.json ...]
// Run tests: node --test "skills/ship-dag/eval/**/*.test.mjs"

import { readFileSync } from 'node:fs';
import { setStats } from './lib/jaccard.mjs';
import { scoreCost } from './lib/score.mjs';
import { mcnemar, bootstrapCI } from '../scripts/lib/stats.mjs';

const isGated = (m) => m.bucket === 'gated' || m.testStatus === 'gated-failed';

/** Per-issue implement Jaccard, keyed `repo#issue`. */
export function jaccardByIssue(raw) {
  const out = new Map();
  for (const r of raw.results || []) {
    if (!r.implement) continue;
    out.set(`${r.repo}#${r.issue}`, setStats(r.implement.predFiles, r.implement.goldFiles).jaccard);
  }
  return out;
}

/** Per-GATED-mutant caught flag, keyed `repo#issue:id` (the shared-bank identity). */
export function gatedCaughtByMutant(raw) {
  const out = new Map();
  for (const r of raw.results || []) {
    for (const m of (r.review && r.review.mutants) || []) {
      if (m.valid === false || !isGated(m)) continue;
      out.set(`${r.repo}#${r.issue}:${m.id}`, !!m.caught);
    }
  }
  return out;
}

const commonKeys = (a, b) => [...a.keys()].filter((k) => b.has(k));

/** Paired recall comparison (reference vs comparator) via exact McNemar. */
export function compareRecall(ref, comp) {
  const a = gatedCaughtByMutant(ref);
  const b = gatedCaughtByMutant(comp);
  const pairs = commonKeys(a, b).map((k) => ({ a: a.get(k), b: b.get(k) }));
  return mcnemar(pairs);
}

/** Paired implement comparison: bootstrap CI of the per-issue Jaccard difference (ref − comp). */
export function compareJaccard(ref, comp, opts) {
  const a = jaccardByIssue(ref);
  const b = jaccardByIssue(comp);
  const diffs = commonKeys(a, b).map((k) => a.get(k) - b.get(k));
  return bootstrapCI(diffs, opts);
}

const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const usd = (x) => (x == null ? '—' : `$${x.toFixed(3)}`);

/** Render the full comparison. `variants` is [{name, raw}], first = reference. */
export function renderReport(variants, opts = {}) {
  const [ref, ...comps] = variants;
  const lines = [];
  lines.push(`Reference: ${ref.name} (n=${(ref.raw.results || []).length} issues)`);
  lines.push('');
  lines.push('Cost (per-stage $ and $/merged):');
  for (const v of variants) {
    const c = scoreCost(v.raw.results || [], v.raw.spec, v.raw.prices || undefined);
    lines.push(`  ${v.name.padEnd(16)} triage ${usd(c.byStage.triage)}  impl ${usd(c.byStage.implement)}  review ${usd(c.byStage.review)}  /merged ${usd(c.perMergedUSD)}${c.tokensMissing ? '  (lower bound)' : ''}`);
  }
  for (const comp of comps) {
    const rec = compareRecall(ref.raw, comp.raw);
    const jac = compareJaccard(ref.raw, comp.raw, opts.bootstrap);
    lines.push('');
    lines.push(`${ref.name} vs ${comp.name}:`);
    lines.push(`  review recall (paired, gated): ${rec.discordant} discordant of ${rec.n} — ${ref.name} +${rec.aOnly} / ${comp.name} +${rec.bOnly}, better=${rec.better === 'a' ? ref.name : rec.better === 'b' ? comp.name : 'tie'}, p=${rec.pValue.toFixed(4)}`);
    lines.push(`  implement Jaccard Δ (ref−comp): mean ${jac.mean == null ? '—' : jac.mean.toFixed(3)}  95% CI [${jac.lo == null ? '—' : jac.lo.toFixed(3)}, ${jac.hi == null ? '—' : jac.hi.toFixed(3)}]  (n=${jac.n})`);
  }
  return lines.join('\n');
}

function main(argv) {
  if (argv.length < 2) {
    process.stderr.write('usage: report.mjs <reference.raw.json> <comparator.raw.json> [more...]\n');
    process.exit(2);
  }
  const variants = argv.map((p) => {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return { name: raw.variant || p, raw };
  });
  process.stdout.write(`${renderReport(variants)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
