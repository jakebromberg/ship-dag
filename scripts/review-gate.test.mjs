// Tests for the deterministic review gate. The gate is recomputed here from
// the findings the Review subagent wrote to disk — the subagent's own claimed
// `verdict` is advisory, because a merge decision must not rest on a model's
// self-report. Run: node --test "skills/ship-dag/scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateReview, parseBlockOn, gateFile, DEFAULT_BLOCK_ON, MAX_LISTED } from './review-gate.mjs';

const finding = (over = {}) => ({
  category: 'correctness',
  verdict: 'CONFIRMED',
  file: 'src/a.ts',
  line: 42,
  summary: 'off-by-one drops the last row',
  failure_scenario: 'a 10-row page renders 9',
  ...over,
});

test('parseBlockOn: splits, trims, lowercases, drops blanks', () => {
  assert.deepEqual(parseBlockOn(' Correctness , security ,, '), ['correctness', 'security']);
  assert.deepEqual(parseBlockOn(undefined), DEFAULT_BLOCK_ON);
  assert.deepEqual(parseBlockOn(''), DEFAULT_BLOCK_ON);
});

test('gateReview: no findings is clean', () => {
  const g = gateReview({ issue: 620, findings: [] });
  assert.equal(g.verdict, 'clean');
  assert.equal(g.blockingCount, 0);
  assert.equal(g.findingCount, 0);
});

test('gateReview: a CONFIRMED finding in a blocked category blocks', () => {
  const g = gateReview({ issue: 620, findings: [finding()] });
  assert.equal(g.verdict, 'blocking');
  assert.equal(g.blockingCount, 1);
});

test('gateReview: PLAUSIBLE never blocks, however severe the category', () => {
  const g = gateReview({ issue: 620, findings: [finding({ verdict: 'PLAUSIBLE', category: 'security' })] });
  assert.equal(g.verdict, 'nits-only');
  assert.equal(g.blockingCount, 0);
});

test('gateReview: a CONFIRMED finding outside --block-on does not block', () => {
  const g = gateReview({ issue: 620, findings: [finding({ category: 'simplification' })] });
  assert.equal(g.verdict, 'nits-only');
});

test('gateReview: --block-on widens the gate', () => {
  const review = { issue: 620, findings: [finding({ category: 'efficiency' })] };
  assert.equal(gateReview(review).verdict, 'nits-only');
  assert.equal(gateReview(review, ['correctness', 'security', 'efficiency']).verdict, 'blocking');
});

test('gateReview: the subagent’s own claimed verdict is ignored, in BOTH directions', () => {
  // A model that under-reports its verdict would silently auto-merge a
  // confirmed correctness defect; one that over-reports would bounce a clean PR
  // into /review-loop forever. The findings decide, not the claim.
  assert.equal(gateReview({ issue: 1, verdict: 'clean', findings: [finding()] }).verdict, 'blocking');
  assert.equal(gateReview({ issue: 1, verdict: 'blocking', findings: [] }).verdict, 'clean');
});

test('gateReview: lists at most MAX_LISTED blocking findings but counts them all', () => {
  const g = gateReview({ issue: 620, findings: Array.from({ length: 7 }, (_, i) => finding({ line: i })) });
  assert.equal(g.blockingCount, 7);
  assert.equal(g.blocking.length, MAX_LISTED);
  // Each listed entry is one line of prose, not the whole finding object.
  assert.deepEqual(Object.keys(g.blocking[0]).sort(), ['category', 'file', 'line', 'summary']);
});

test('gateReview: category matching is case-insensitive', () => {
  assert.equal(gateReview({ issue: 1, findings: [finding({ category: 'Security', verdict: 'confirmed' })] }).verdict, 'blocking');
});

test('gateReview: counts nits separately so the wave summary can cite them without reading the file', () => {
  const g = gateReview({ issue: 1, findings: [finding(), finding({ category: 'simplification' }), finding({ verdict: 'PLAUSIBLE' })] });
  assert.equal(g.blockingCount, 1);
  assert.equal(g.nitCount, 2);
  assert.equal(g.findingCount, 3);
});

test('gateReview: a review with no findings array is a hard error, never a silent clean', () => {
  // The dangerous failure: a truncated or half-written review file reading as
  // "nothing wrong" and auto-merging.
  assert.throws(() => gateReview({ issue: 1 }), /findings/);
  assert.throws(() => gateReview(null), /findings/);
});

test('gateReview: an unrecognized category fails closed — it cannot yield a mergeable verdict', () => {
  const g = gateReview({ issue: 1, findings: [finding({ category: 'vibes', verdict: 'PLAUSIBLE' })] });
  assert.deepEqual(g.unknownCategories, ['vibes']);
  assert.equal(g.verdict, 'blocking');
  assert.equal(g.blockingCount, 1);
});

test('gateReview: an unrecognized category alongside a genuine blocking finding still blocks, and counts both', () => {
  const g = gateReview({
    issue: 1,
    findings: [finding(), finding({ category: 'contract', verdict: 'PLAUSIBLE' })],
  });
  assert.equal(g.verdict, 'blocking');
  assert.equal(g.blockingCount, 2);
  assert.deepEqual(g.unknownCategories, ['contract']);
});

test('gateReview: an unrecognized category alongside only real nits still blocks — it is never scored as a nit', () => {
  const g = gateReview({
    issue: 1,
    findings: [finding({ category: 'simplification' }), finding({ category: 'test-quality' })],
  });
  assert.equal(g.verdict, 'blocking');
  assert.equal(g.blockingCount, 1);
  assert.equal(g.nitCount, 1);
  assert.deepEqual(g.unknownCategories, ['test-quality']);
});

test('gateReview: a blank or absent category fails closed the same way, reported as (blank)', () => {
  const blank = gateReview({ issue: 1, findings: [finding({ category: '' })] });
  assert.equal(blank.verdict, 'blocking');
  assert.deepEqual(blank.unknownCategories, ['(blank)']);

  const absent = gateReview({ issue: 1, findings: [finding({ category: undefined })] });
  assert.equal(absent.verdict, 'blocking');
  assert.deepEqual(absent.unknownCategories, ['(blank)']);
});

test('gateFile: reads a review off disk and carries its path through for the human', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-dag-review-'));
  const p = join(dir, 'daisysguide%2Fbackend%23620.json');
  writeFileSync(p, JSON.stringify({ issue: 620, verdict: 'nits-only', findings: [finding()] }));
  const g = gateFile(p);
  assert.equal(g.verdict, 'blocking');
  assert.equal(g.path, p);
  assert.equal(g.issue, 620);
});
