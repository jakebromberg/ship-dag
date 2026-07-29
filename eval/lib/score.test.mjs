// Tests for score.mjs. Run: node --test "skills/ship-dag/eval/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreImplement, scoreFirstPass, scoreReview, scoreTriage, scoreCost, buildScorecard } from './score.mjs';

const SPEC = { triage: { model: 'haiku' }, implement: { model: 'sonnet' }, review: { model: 'opus' } };

test('scoreImplement: aggregates jaccard/precision/recall and groups by tier', () => {
  const s = scoreImplement([
    { tier: 'normal', implement: { predFiles: ['a', 'b'], goldFiles: ['a', 'b'] } }, // jaccard 1
    { tier: 'normal', implement: { predFiles: ['a', 'x'], goldFiles: ['a', 'b'] } }, // jaccard 1/3
    { tier: 'complex', implement: null }, // skipped
  ]);
  assert.equal(s.n, 2);
  assert.equal(s.jaccardMean, (1 + 1 / 3) / 2);
  assert.equal(s.byTier.normal.n, 2);
  assert.equal(s.byTier.complex, undefined);
});

test('scoreFirstPass: merged-without-bounce over issues that reached review', () => {
  const s = scoreFirstPass([
    { firstPass: { verdict: 'merged', bounced: false } },
    { firstPass: { verdict: 'merged', bounced: true } },
    { firstPass: { verdict: 'blocked', bounced: true } },
    { firstPass: { verdict: null, bounced: false } }, // never reached → excluded
  ]);
  assert.equal(s.reached, 3);
  assert.equal(s.firstPassYield, 1 / 3);
  assert.equal(s.bounceRate, 2 / 3);
});

test('scoreReview: recall over valid mutants, by kind, dropping invalid seeds', () => {
  const s = scoreReview([
    { review: { mutants: [
      { kind: 'relational', caught: true, valid: true },
      { kind: 'relational', caught: false, valid: true },
      { kind: 'await', caught: true, valid: true },
      { kind: 'await', caught: false, valid: false }, // never seeded → excluded
    ] } },
  ]);
  assert.equal(s.n, 3);
  assert.equal(s.caught, 2);
  assert.equal(s.recall, 2 / 3);
  assert.equal(s.byKind.relational.recall, 0.5);
  assert.equal(s.byKind.await.n, 1);
});

test('scoreTriage: complexity accuracy vs realized tier, adjacent, confusion, routing', () => {
  const s = scoreTriage([
    { tier: 'normal', triage: { complexity: 'normal', routing: 'clear' } }, // exact
    { tier: 'complex', triage: { complexity: 'normal', routing: 'clear' } }, // off-by-one
    { tier: 'mechanical', triage: { complexity: 'complex', routing: 'needs-decision' } }, // two-step miss
    { tier: 'normal', implement: null }, // no triage → excluded from accuracy
  ]);
  assert.equal(s.n, 3);
  assert.equal(s.complexityAccuracy, 1 / 3); // only the first is exact
  assert.equal(s.complexityAdjacentAccuracy, 2 / 3); // exact + off-by-one, not the two-step
  assert.equal(s.confusion.complex.normal, 1);
  assert.deepEqual(s.routingCounts, { clear: 2, 'needs-decision': 1 });
});

test('scoreTriage: empty when no triage ran', () => {
  const s = scoreTriage([{ tier: 'normal', implement: null }]);
  assert.equal(s.n, 0);
  assert.equal(s.complexityAccuracy, null);
});

test('scoreReview: splits headline gated recall from parse-only, and buckets by tier', () => {
  const s = scoreReview([
    { review: { mutants: [
      { kind: 'relational', tier: 'normal', bucket: 'gated', caught: true, valid: true },
      { kind: 'relational', tier: 'complex', bucket: 'gated', caught: false, valid: true },
      { kind: 'boolean', tier: 'normal', bucket: 'parse-only', caught: true, valid: true },
    ] } },
  ]);
  assert.equal(s.n, 3);
  assert.equal(s.nGated, 2);
  assert.equal(s.recallGated, 0.5); // 1 of 2 gated caught
  assert.equal(s.nParseOnly, 1);
  assert.equal(s.recallParseOnly, 1); // the one parse-only was caught
  assert.equal(s.byTier.normal.n, 2);
  assert.equal(s.byTier.complex.recall, 0);
});

test('scoreFirstPass: buckets yield by tier', () => {
  const s = scoreFirstPass([
    { tier: 'normal', firstPass: { verdict: 'merged', bounced: false } },
    { tier: 'normal', firstPass: { verdict: 'blocked', bounced: true } },
    { tier: 'complex', firstPass: { verdict: 'merged', bounced: false } },
  ]);
  assert.equal(s.byTier.normal.firstPassYield, 0.5);
  assert.equal(s.byTier.complex.firstPassYield, 1);
});

test('scoreCost: output-tokens × model price, with $/merged', () => {
  const results = [
    { firstPass: { verdict: 'merged' }, tokens: { triage: 1e6, implement: 1e6, review: 1e6 } },
  ];
  const c = scoreCost(results, SPEC);
  // haiku 5 + sonnet 15 + opus 25 = 45 USD/Mtok each at 1 Mtok
  assert.equal(c.byStage.triage, 5);
  assert.equal(c.byStage.implement, 15);
  assert.equal(c.byStage.review, 25);
  assert.equal(c.totalUSD, 45);
  assert.equal(c.perMergedUSD, 45);
  assert.equal(c.tokensMissing, false);
});

test('scoreCost: null tokens make the total a flagged lower bound', () => {
  const c = scoreCost([{ firstPass: { verdict: 'merged' }, tokens: { triage: null, implement: 1e6, review: null } }], SPEC);
  assert.equal(c.totalUSD, 15);
  assert.equal(c.tokensMissing, true);
});

test('scoreCost: no merged issues → perMergedUSD null (no divide-by-zero)', () => {
  const c = scoreCost([{ firstPass: { verdict: 'blocked' }, tokens: { triage: 1e6, implement: null, review: null } }], SPEC);
  assert.equal(c.perMergedUSD, null);
});

test('buildScorecard: ties tracks together and warns on lower-bound cost + placeholder prices + empty recall', () => {
  const card = buildScorecard({
    runId: 'r1',
    variant: 'current',
    spec: SPEC,
    results: [
      { tier: 'normal', implement: { predFiles: ['a'], goldFiles: ['a'] }, firstPass: { verdict: 'merged', bounced: false }, review: { mutants: [] }, tokens: { triage: null, implement: null, review: null } },
    ],
  });
  assert.equal(card.runId, 'r1');
  assert.equal(card.implement.jaccardMean, 1);
  assert.equal(card.firstPass.firstPassYield, 1);
  assert.ok(card.warnings.some((w) => /LOWER BOUND/.test(w)));
  assert.ok(card.warnings.some((w) => /default rate table/.test(w)));
  assert.ok(card.warnings.some((w) => /recall track is empty/.test(w)));
  assert.ok(card.warnings.some((w) => /triage track is empty/.test(w)));
});

test('buildScorecard: surfaces the triage track and warns on a thin gated bucket', () => {
  const card = buildScorecard({
    runId: 'r2',
    variant: 'current',
    spec: SPEC,
    prices: { haiku: 5, sonnet: 15, opus: 25 },
    results: [
      {
        tier: 'normal',
        triage: { complexity: 'normal', routing: 'clear' },
        implement: { predFiles: ['a'], goldFiles: ['a'] },
        firstPass: { verdict: 'merged', bounced: false },
        review: { mutants: [{ kind: 'relational', tier: 'normal', bucket: 'gated', caught: true, valid: true }] },
        tokens: { triage: 1e6, implement: 1e6, review: 1e6 },
      },
    ],
  });
  assert.equal(card.triage.n, 1);
  assert.equal(card.triage.complexityAccuracy, 1);
  assert.ok(card.warnings.some((w) => /THIN test-gated bucket/.test(w))); // nGated=1 < 20
  assert.ok(!card.warnings.some((w) => /triage track is empty/.test(w)));
});
