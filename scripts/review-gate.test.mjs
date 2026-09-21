// Tests for the deterministic review gate. The gate is recomputed here from
// the findings the Review subagent wrote to disk — the subagent's own claimed
// `verdict` is advisory, because a merge decision must not rest on a model's
// self-report. Run: node --test "skills/ship-dag/scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateReview, parseBlockOn, gateFile, CATEGORIES, DEFAULT_BLOCK_ON, MAX_LISTED } from './review-gate.mjs';

const finding = (over = {}) => ({
  category: 'correctness',
  verdict: 'CONFIRMED',
  file: 'src/a.ts',
  line: 42,
  summary: 'off-by-one drops the last row',
  failure_scenario: 'a 10-row page renders 9',
  ...over,
});

/** Write a review object to a fresh temp file and return its path. */
const reviewFile = (review) => {
  const p = join(mkdtempSync(join(tmpdir(), 'ship-dag-review-')), 'review.json');
  writeFileSync(p, JSON.stringify(review));
  return p;
};

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'review-gate.mjs');

/**
 * Run the gate the way an operator does — a real process, real argv, real
 * streams, real exit code. The unit tests stop at `gateReview`, which is how
 * the `blocking[]` projection shipped without a `category` key at all: the
 * defect only exists once `JSON.stringify` drops the `undefined`.
 */
const runCli = (args) => {
  const r = spawnSync(process.execPath, [GATE, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};

test('parseBlockOn: splits, trims, lowercases, drops blanks', () => {
  assert.deepEqual(parseBlockOn(' Correctness , security ,, '), ['correctness', 'security']);
  assert.deepEqual(parseBlockOn(undefined), DEFAULT_BLOCK_ON);
  assert.deepEqual(parseBlockOn(''), DEFAULT_BLOCK_ON);
});

test('parseBlockOn: rejects a category outside the enum instead of gating on one no finding can carry', () => {
  // `--block-on test-quality` used to validate nothing: the gate silently fell
  // back to correctness,security and auto-merged a PR the operator believed
  // they had widened the gate for.
  assert.throws(() => parseBlockOn('test-quality'), /test-quality/);
  assert.throws(() => parseBlockOn('correctness,vibes'), /vibes/);
  // Every enum member is accepted, so a legitimately widened gate never trips this.
  assert.deepEqual(parseBlockOn(CATEGORIES.join(',')), CATEGORIES);
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

test('gateReview: a category padded with whitespace is that category, not an unknown one', () => {
  // `parseBlockOn` trims the operator's side. Not trimming the finding's side
  // reported `unknown categories: correctness` — telling the operator a
  // manifestly valid category was unrecognized, with nothing to act on.
  const g = gateReview({ issue: 1, findings: [finding({ category: ' Correctness ' })] });
  assert.equal(g.verdict, 'blocking');
  assert.deepEqual(g.unknownCategories, []);
  // Whitespace-only is still blank, and blank still fails closed.
  const blank = gateReview({ issue: 1, findings: [finding({ category: '   ' })] });
  assert.equal(blank.verdict, 'blocking');
  assert.deepEqual(blank.unknownCategories, ['(blank)']);
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

test('CLI: an unrecognized category blocks, and stderr names it without the operator opening the review', () => {
  const p = reviewFile({ issue: 620, findings: [finding({ category: 'vibes', verdict: 'PLAUSIBLE' })] });
  const { code, stdout, stderr } = runCli([p]);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.verdict, 'blocking');
  assert.deepEqual(out.unknownCategories, ['vibes']);
  assert.equal(out.path, p);
  // #25's second acceptance criterion: the one-line summary is enough to act on.
  assert.match(stderr, /#620 blocking — 1 blocking, 0 nits/);
  // JSON-quoted, so a value carrying whitespace or punctuation is unambiguous.
  assert.match(stderr, /unknown categories: "vibes"/);
});

test('CLI: a blank category is reported quoted and still carries a category key in blocking[]', () => {
  const p = reviewFile({ issue: 620, findings: [finding({ category: undefined })] });
  const { code, stdout, stderr } = runCli([p]);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  // `category: f.category` alone emitted `undefined`, which JSON.stringify drops
  // outright — the entry reached the operator with no `category` field at all.
  assert.deepEqual(Object.keys(out.blocking[0]).sort(), ['category', 'file', 'line', 'summary']);
  assert.equal(out.blocking[0].category, null);
  assert.match(stderr, /unknown categories: "\(blank\)"/);
});

test('CLI: --block-on accepts the equals spelling identically to the space-separated one', () => {
  // `argv.indexOf('--block-on')` ignored `--block-on=<list>` outright, so an
  // operator who widened the gate silently got the narrower default instead.
  const p = reviewFile({ issue: 620, findings: [finding({ category: 'efficiency' })] });
  assert.equal(JSON.parse(runCli([p]).stdout).verdict, 'nits-only');
  const spaced = runCli([p, '--block-on', 'correctness,security,efficiency']);
  const equals = runCli([p, '--block-on=correctness,security,efficiency']);
  assert.equal(JSON.parse(spaced.stdout).verdict, 'blocking');
  assert.deepEqual(JSON.parse(equals.stdout), JSON.parse(spaced.stdout));
  assert.equal(equals.stderr, spaced.stderr);
});

test('CLI: --block-on naming a category outside the enum is a loud usage error, not a quieter gate', () => {
  const p = reviewFile({ issue: 620, findings: [finding()] });
  for (const args of [[p, '--block-on', 'test-quality'], [p, '--block-on=test-quality']]) {
    const { code, stdout, stderr } = runCli(args);
    assert.equal(code, 2, `expected a usage error for ${args.join(' ')}`);
    assert.equal(stdout, '');
    assert.match(stderr, /"test-quality"/);
    // The message carries the enum, so the operator can correct it in one pass.
    assert.match(stderr, /correctness, security, simplification, efficiency, test-coverage/);
  }
});

test('CLI: exit codes separate a malformed invocation from an unreadable review', () => {
  const none = runCli([]);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /usage: review-gate\.mjs/);

  const truncated = runCli([reviewFile({ issue: 620 })]);
  assert.equal(truncated.code, 3);
  assert.equal(truncated.stdout, '');
  assert.match(truncated.stderr, /findings/);
});
