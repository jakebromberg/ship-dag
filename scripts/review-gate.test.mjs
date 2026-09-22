// Tests for the deterministic review gate. The gate is recomputed here from
// the findings the Review subagent wrote to disk — the subagent's own claimed
// `verdict` is advisory, because a merge decision must not rest on a model's
// self-report. Run: node --test "skills/ship-dag/scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gateReview,
  parseBlockOn,
  gateFile,
  normalizeCategory,
  renderUnusable,
  ALWAYS_BLOCK,
  CATEGORIES,
  CATEGORY_ALIASES,
  DEFAULT_BLOCK_ON,
  MAX_LISTED,
  MAX_VALUE_CHARS,
  parseExpectFindings,
} from './review-gate.mjs';

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

test('normalizeCategory: maps each known alias to its canonical spelling, and passes through the rest', () => {
  // Literal cases, not a loop over CATEGORY_ALIASES: deriving the cases from the
  // map under test made this pass vacuously — empty the map and the loop ran
  // zero times, so the one thing the test exists to catch could not turn it red.
  assert.equal(normalizeCategory('conventions'), 'convention');
  assert.equal(normalizeCategory('contract-conformance'), 'contract');
  assert.equal(normalizeCategory('correctness'), 'correctness');
  assert.equal(normalizeCategory('vibes'), 'vibes');
});

test('normalizeCategory: an Object.prototype key is a category like any other, never an inherited member', () => {
  // `CATEGORY_ALIASES` was an object literal, so `['constructor']` resolved to
  // the `Object` function and `['__proto__']` to `Object.prototype`. The gate
  // still failed closed, but the *report* broke: JSON.stringify drops a
  // function, so `unknownCategories` read `[null]` and `blocking[]` shipped
  // with no `category` key — defeating #25's "name it without opening the
  // review file". Pass-through is the only correct answer for all three.
  for (const key of ['constructor', '__proto__', 'tostring', 'hasownproperty', 'valueof']) {
    assert.equal(normalizeCategory(key), key, `${key} must pass through unchanged`);
  }
});

test('CATEGORY_ALIASES: every alias resolves to a real category and is not itself one', () => {
  // The assertion nothing made before: an alias pointing at a non-category
  // would normalize a finding into a name the membership test rejects, failing
  // it closed forever with no way for a reviewer to spell it correctly.
  assert.ok(CATEGORY_ALIASES.size > 0, 'an empty alias map makes the loop below vacuous');
  for (const [alias, canonical] of CATEGORY_ALIASES) {
    assert.ok(CATEGORIES.includes(canonical), `alias ${alias} points at ${canonical}, which is not a category`);
    assert.ok(!CATEGORIES.includes(alias), `${alias} is a category, so aliasing it away makes it unspellable`);
  }
});

test('parseBlockOn: normalizes an aliased spelling before validating it, rather than rejecting it', () => {
  assert.deepEqual(parseBlockOn('conventions'), ['convention']);
  assert.deepEqual(parseBlockOn('correctness,contract-conformance'), ['correctness', 'contract']);
});

test('gateReview: the --block-on side is normalized too, so a programmatic caller gates identically to the CLI', () => {
  // The CLI funnels its list through `parseBlockOn`, which normalizes. A caller
  // importing `gateReview` does not, so lowercasing alone left the exported API
  // gating on a spelling no finding can carry — the same silent narrowing
  // `parseBlockOn` was added to prevent, one layer down.
  const review = { issue: 1, findings: [finding({ category: 'contract' })] };
  assert.equal(gateReview(review, ['correctness', 'contract-conformance']).verdict, 'blocking');
  const conventions = { issue: 1, findings: [finding({ category: 'convention' })] };
  assert.equal(gateReview(conventions, ['Conventions ']).verdict, 'blocking');
  // Both sides normalize, so every spelling of one category matches every other.
  assert.equal(gateReview(conventions, ['convention']).verdict, 'blocking');
  assert.equal(gateReview({ issue: 1, findings: [finding({ category: 'conventions' })] }, ['convention']).verdict, 'blocking');
});

test('gateReview: an aliased category normalizes to its canonical spelling BEFORE the enum membership test — this is the inversion check', () => {
  // If normalization ran after the membership test (checking `CATEGORIES.includes('conventions')`
  // instead of `CATEGORIES.includes(normalizeCategory('conventions'))`), the alias map would be
  // dead code: 'conventions' isn't itself in CATEGORIES, so it would fail closed exactly like a
  // genuinely unrecognized category. Tamper-verified: moving normalization after the `known` check
  // turns this red (unknownCategories becomes ['conventions'] instead of []).
  const g = gateReview({ issue: 1, findings: [finding({ category: 'conventions', verdict: 'PLAUSIBLE' })] });
  assert.deepEqual(g.unknownCategories, []);
  assert.equal(g.blocking.length, 0);
  assert.equal(g.nitCount, 1);

  const h = gateReview({ issue: 1, findings: [finding({ category: 'contract-conformance', verdict: 'PLAUSIBLE' })] });
  assert.deepEqual(h.unknownCategories, []);
});

test('gateReview: convention and contract are now in the default gate, discharging the #26 obligation', () => {
  const g = gateReview({ issue: 1, findings: [finding({ category: 'convention' }), finding({ category: 'contract' })] });
  assert.deepEqual(g.unknownCategories, []);
  assert.equal(g.verdict, 'blocking');
  assert.equal(g.blockingCount, 2);
});

test('gateReview: contract blocks once an operator widens --block-on to include it', () => {
  const g = gateReview({ issue: 1, findings: [finding({ category: 'contract' })] }, ['correctness', 'security', 'contract']);
  assert.equal(g.verdict, 'blocking');
  assert.equal(g.blockingCount, 1);
});

// --- The reviewer's own blocking/nit call (#27) -----------------------------

test('gateReview: the motivating case — two test-coverage findings, one blocking and one not, block exactly once', () => {
  const blockOn = [...DEFAULT_BLOCK_ON, 'test-coverage'];
  const g = gateReview(
    {
      issue: 1,
      findings: [
        finding({ category: 'test-coverage', summary: 'assertion cannot fail in the direction the test exists for', blocking: true }),
        finding({ category: 'test-coverage', summary: 'documentary {} test case', blocking: false }),
      ],
    },
    blockOn,
  );
  assert.equal(g.blockingCount, 1);
  assert.equal(g.nitCount, 1);
});

test('gateReview: omitting the blocking field fails toward blocking, not toward merging', () => {
  const g = gateReview({ issue: 1, findings: [finding({ category: 'test-coverage', blocking: undefined })] }, [
    ...DEFAULT_BLOCK_ON,
    'test-coverage',
  ]);
  assert.equal(g.verdict, 'blocking');
  assert.equal(g.blockingCount, 1);
});

test('gateReview: the new axis is never sufficient on its own to clear a CONFIRMED correctness finding', () => {
  // A reviewer marking its own correctness defect a "nit" must not be able to
  // un-block it — that would let the model grade its own homework, exactly
  // what recomputing the gate from findings[] exists to prevent.
  const g = gateReview({ issue: 1, findings: [finding({ category: 'correctness', blocking: false })] });
  assert.equal(g.verdict, 'blocking');
  assert.equal(g.blockingCount, 1);
});

test('gateReview: the new axis is never sufficient on its own to clear a CONFIRMED security finding', () => {
  const g = gateReview({ issue: 1, findings: [finding({ category: 'security', blocking: false })] });
  assert.equal(g.verdict, 'blocking');
  assert.equal(g.blockingCount, 1);
});

test('gateReview: #26 obligation discharged — a CONFIRMED contract finding no longer auto-merges silently', () => {
  const g = gateReview({ issue: 1, findings: [finding({ category: 'contract' })] });
  assert.equal(g.verdict, 'blocking');
  assert.equal(g.blockingCount, 1);
  assert.deepEqual(g.unknownCategories, []);
});

test('gateReview: #26 obligation discharged — a CONFIRMED convention finding no longer auto-merges silently', () => {
  const g = gateReview({ issue: 1, findings: [finding({ category: 'convention' })] });
  assert.equal(g.verdict, 'blocking');
  assert.equal(g.blockingCount, 1);
});

test('gateReview: a convention nit the reviewer itself flagged non-blocking stays a nit', () => {
  const g = gateReview({ issue: 1, findings: [finding({ category: 'convention', blocking: false })] });
  assert.equal(g.verdict, 'nits-only');
  assert.equal(g.nitCount, 1);
});

test('gateReview: clearing a CONFIRMED finding by the reviewer’s own say-so leaves a trace, not just a nit', () => {
  // Folded into `nitCount` alone, this result is bit-identical to a review
  // that merely had a PLAUSIBLE nit — and the reviewer downgrading its own
  // CONFIRMED finding is the one thing about this axis worth an operator's
  // scrutiny. `unknownCategories[]` signals the other fail-closed path; this
  // is its counterpart on the path that merges.
  const cleared = gateReview({
    issue: 1,
    findings: [finding({ category: 'convention', summary: 'brace style', blocking: false })],
  });
  const plausible = gateReview({ issue: 1, findings: [finding({ category: 'convention', verdict: 'PLAUSIBLE' })] });
  assert.equal(cleared.verdict, plausible.verdict);
  assert.equal(cleared.nitCount, plausible.nitCount);
  // ...and yet the two are distinguishable, which is the whole point.
  assert.equal(cleared.selfClearedCount, 1);
  assert.deepEqual(cleared.selfCleared, [{ category: 'convention', file: 'src/a.ts', line: 42, summary: 'brace style' }]);
  assert.equal(plausible.selfClearedCount, 0);
  assert.deepEqual(plausible.selfCleared, []);
});

test('gateReview: only a finding the axis actually cleared is counted as self-cleared', () => {
  // A `blocking: false` that changed nothing — the category was never in the
  // gate, or ALWAYS_BLOCK overrode it — must not inflate the signal, or the
  // operator learns to ignore it.
  const outside = gateReview({ issue: 1, findings: [finding({ category: 'simplification', blocking: false })] });
  assert.equal(outside.selfClearedCount, 0);
  const carvedOut = gateReview({ issue: 1, findings: [finding({ category: 'correctness', blocking: false })] });
  assert.equal(carvedOut.verdict, 'blocking');
  assert.equal(carvedOut.selfClearedCount, 0);
  const plausible = gateReview({ issue: 1, findings: [finding({ category: 'convention', verdict: 'PLAUSIBLE', blocking: false })] });
  assert.equal(plausible.selfClearedCount, 0);
});

test('gateReview: selfCleared[] lists at most MAX_LISTED but counts them all', () => {
  const findings = Array.from({ length: MAX_LISTED + 2 }, (_, i) =>
    finding({ category: 'convention', summary: `nit ${i}`, blocking: false }),
  );
  const g = gateReview({ issue: 1, findings });
  assert.equal(g.selfClearedCount, MAX_LISTED + 2);
  assert.equal(g.selfCleared.length, MAX_LISTED);
});

// `blocking` is validated, not coerced. Its neighbours in the same loop coerce
// — `verdict` through `String(...).toUpperCase()`, `category` through
// trim/lowercase/alias — because any string those carry is still *some* claim
// the gate can score. `blocking` has exactly two usable values, so anything
// else is the reviewer failing to answer, and coercing would mean guessing
// which junk value meant "clear this", in the one direction that merges code.
for (const claimed of ['false', 'no', 'true', 0, 1, null, {}, []]) {
  test(`gateReview: blocking: ${JSON.stringify(claimed)} is not a usable clearance, and is named rather than ignored`, () => {
    const g = gateReview({ issue: 1, findings: [finding({ category: 'convention', blocking: claimed })] });
    assert.equal(g.verdict, 'blocking', 'an unusable value must fail toward blocking, like an omitted one');
    assert.equal(g.blockingCount, 1);
    assert.equal(g.selfClearedCount, 0);
    assert.deepEqual(g.malformedBlocking, [JSON.stringify(claimed)]);
  });
}

test('gateReview: an unusable blocking value that could not have decided anything is not reported', () => {
  // Same principle the self-cleared signal applies: a value the gate would
  // have ignored regardless is not news, and reporting it teaches the operator
  // to skim past the field. Only the position where a boolean `false` would
  // have cleared the finding counts.
  const plausible = gateReview({ issue: 1, findings: [finding({ category: 'convention', verdict: 'PLAUSIBLE', blocking: 'false' })] });
  assert.deepEqual(plausible.malformedBlocking, []);
  const ungated = gateReview({ issue: 1, findings: [finding({ category: 'simplification', blocking: 'false' })] });
  assert.deepEqual(ungated.malformedBlocking, []);
  const carvedOut = gateReview({ issue: 1, findings: [finding({ category: 'correctness', blocking: 'false' })] });
  assert.equal(carvedOut.verdict, 'blocking');
  assert.deepEqual(carvedOut.malformedBlocking, []);
  const unknownCategory = gateReview({ issue: 1, findings: [finding({ category: 'vibes', blocking: 'false' })] });
  assert.deepEqual(unknownCategory.malformedBlocking, []);
});

test('renderUnusable: reviewer-authored text cannot spend the whole result budget', () => {
  // This script exists to keep a per-PR merge decision to a few hundred bytes,
  // and the value is written by the reviewer: `blocking: { why: <prose> }`
  // would otherwise land in full on stdout *and* on the stderr summary line.
  assert.equal(renderUnusable('false'), '\"false\"');
  assert.equal(renderUnusable(0), '0');
  assert.equal(renderUnusable(null), 'null');
  const long = renderUnusable({ why: 'x'.repeat(500) });
  assert.equal(long.length, MAX_VALUE_CHARS + 1, 'a long value is truncated to MAX_VALUE_CHARS plus the ellipsis');
  assert.ok(long.endsWith('…'));
});

test('gateReview: malformedBlocking is rendered and capped, so a verbose reviewer cannot flood the result', () => {
  const findings = Array.from({ length: MAX_LISTED + 2 }, (_, i) =>
    finding({ category: 'convention', blocking: { why: `${i}${'x'.repeat(500)}` } }),
  );
  const g = gateReview({ issue: 1, findings });
  assert.equal(g.blockingCount, MAX_LISTED + 2, 'every one of them still blocks');
  assert.equal(g.malformedBlocking.length, MAX_LISTED);
  for (const value of g.malformedBlocking) assert.ok(value.length <= MAX_VALUE_CHARS + 1, `${value} is not bounded`);
});

test('gateReview: a usable blocking value is never reported as malformed, and neither is an omitted one', () => {
  for (const f of [finding({ blocking: true }), finding({ category: 'convention', blocking: false }), finding({})]) {
    assert.deepEqual(gateReview({ issue: 1, findings: [f] }).malformedBlocking, []);
  }
});

test('gateReview: malformedBlocking names each distinct unusable value once, across findings', () => {
  const g = gateReview({
    issue: 1,
    findings: [
      finding({ category: 'convention', blocking: 'false' }),
      finding({ category: 'contract', blocking: 'false' }),
      finding({ category: 'convention', blocking: 0 }),
    ],
  });
  assert.deepEqual(g.malformedBlocking, ['"false"', '0']);
  assert.equal(g.blockingCount, 3);
});

test('ALWAYS_BLOCK: every always-blocking category is a real category, canonically spelled, and in the default gate', () => {
  // A third overlapping list, on top of CATEGORIES and DEFAULT_BLOCK_ON and
  // the alias map. A member outside CATEGORIES can never be matched; a member
  // outside DEFAULT_BLOCK_ON is an inert carve-out over a category the default
  // gate does not block; a non-canonical spelling never matches either, since
  // the gate tests membership *after* normalizeCategory.
  assert.ok(ALWAYS_BLOCK.length > 0, 'an empty ALWAYS_BLOCK makes the loop below vacuous');
  for (const category of ALWAYS_BLOCK) {
    assert.ok(CATEGORIES.includes(category), `ALWAYS_BLOCK names ${category}, which is not in CATEGORIES`);
    assert.equal(normalizeCategory(category), category, `ALWAYS_BLOCK names ${category}, which is an alias rather than a canonical spelling`);
    assert.ok(
      DEFAULT_BLOCK_ON.includes(category),
      `ALWAYS_BLOCK names ${category}, which the default gate does not block — the carve-out would be inert by default`,
    );
  }
  // The same membership rule for the default gate itself: parseBlockOn enforces
  // it for an operator's list but returns DEFAULT_BLOCK_ON unchecked.
  assert.ok(DEFAULT_BLOCK_ON.length > 0, 'an empty DEFAULT_BLOCK_ON disables blocking entirely');
  for (const category of DEFAULT_BLOCK_ON) {
    assert.ok(CATEGORIES.includes(category), `DEFAULT_BLOCK_ON names ${category}, which no finding can carry`);
    assert.equal(normalizeCategory(category), category, `DEFAULT_BLOCK_ON names ${category}, which is an alias rather than a canonical spelling`);
  }
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
    findings: [finding(), finding({ category: 'documentation', verdict: 'PLAUSIBLE' })],
  });
  assert.equal(g.verdict, 'blocking');
  assert.equal(g.blockingCount, 2);
  assert.deepEqual(g.unknownCategories, ['documentation']);
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

test('gateReview: a category named after an Object.prototype key is reported as itself, not as an inherited value', () => {
  // The alias map used to be an object literal, so `constructor` resolved to
  // the `Object` function and `__proto__` to `Object.prototype`. The gate still
  // blocked — but `unknownCategories` carried a function and an object instead
  // of strings, which is what the operator reads to learn what to fix.
  const g = gateReview({
    issue: 1,
    findings: [
      finding({ category: 'constructor', verdict: 'PLAUSIBLE' }),
      finding({ category: '__proto__', verdict: 'PLAUSIBLE' }),
      finding({ category: 'toString', verdict: 'PLAUSIBLE' }),
    ],
  });
  assert.equal(g.verdict, 'blocking');
  assert.equal(g.blockingCount, 3);
  assert.deepEqual(g.unknownCategories, ['constructor', '__proto__', 'tostring']);
  assert.deepEqual(
    g.blocking.map((b) => b.category),
    ['constructor', '__proto__', 'tostring'],
  );
});

test('parseBlockOn: an Object.prototype key on the operator’s side is rejected by name', () => {
  // Same defect on the other side of the gate: the thrown message ran the
  // resolved value through JSON.stringify, which renders a function as
  // `undefined` — "--block-on names undefined" told the operator nothing.
  assert.throws(() => parseBlockOn('constructor'), /"constructor"/);
  assert.throws(() => parseBlockOn('__proto__'), /"__proto__"/);
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

test('gateReview: real blocking findings lead the listed window, taxonomy errors trail it', () => {
  // `blocking[]` is truncated to MAX_LISTED, and a reviewer who coins three
  // category names in one review would otherwise push the null-deref and the
  // plaintext-token finding out of the only list the operator reads.
  const g = gateReview({
    issue: 1,
    findings: [
      finding({ category: 'naming nit', verdict: 'PLAUSIBLE', summary: 'coined a' }),
      finding({ category: 'style', verdict: 'PLAUSIBLE', summary: 'coined b' }),
      finding({ category: 'docs', verdict: 'PLAUSIBLE', summary: 'coined c' }),
      finding({ category: 'correctness', summary: 'null deref' }),
      finding({ category: 'security', summary: 'plaintext token' }),
    ],
  });
  assert.equal(g.blockingCount, 5);
  assert.deepEqual(
    g.blocking.map((b) => b.summary),
    ['null deref', 'plaintext token', 'coined a'],
  );
});

test('gateReview: blocking[].category reports the same normalized value unknownCategories[] does', () => {
  const g = gateReview({ issue: 1, findings: [finding({ category: ' Vibes ' })] });
  assert.deepEqual(g.unknownCategories, ['vibes']);
  assert.equal(g.blocking[0].category, 'vibes');
  // Blank stays null in the projection — `(blank)` is the report's sentinel, not a value.
  const blank = gateReview({ issue: 1, findings: [finding({ category: '  ' })] });
  assert.equal(blank.blocking[0].category, null);
});

test('gateReview: a null entry in findings[] blocks instead of crashing the gate', () => {
  const g = gateReview({ issue: 1, findings: [null] });
  assert.equal(g.verdict, 'blocking');
  assert.deepEqual(g.blocking[0], { category: null, file: null, line: null, summary: null });
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

test('CLI: a category named after an Object.prototype key survives JSON.stringify and is named on stderr', () => {
  // The unit tests above catch the wrong *value*; only the CLI shows the cost.
  // `JSON.stringify` drops a function, so with the old object-literal alias map
  // this printed `"unknownCategories": [null]`, a `blocking[]` entry missing its
  // `category` key entirely, and a stderr line naming nothing at all.
  const p = reviewFile({ issue: 620, findings: [finding({ category: 'constructor', verdict: 'PLAUSIBLE' })] });
  const { code, stdout, stderr } = runCli([p]);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.verdict, 'blocking');
  assert.deepEqual(out.unknownCategories, ['constructor']);
  assert.equal(out.blocking[0].category, 'constructor');
  assert.match(stderr, /unknown categories: "constructor"/);
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
    assert.match(stderr, new RegExp(CATEGORIES.join(', ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('CLI: --block-on is positional-independent — the list is never mistaken for the review path', () => {
  // `argv.find((a) => !a.startsWith('--'))` took the *list* as the path when the
  // flag came first, so a malformed invocation died as exit 3 "unreadable review".
  const p = reviewFile({ issue: 620, findings: [finding({ category: 'efficiency' })] });
  const after = runCli([p, '--block-on', 'correctness,security,efficiency']);
  const before = runCli(['--block-on', 'correctness,security,efficiency', p]);
  assert.equal(before.code, 0, before.stderr);
  assert.deepEqual(JSON.parse(before.stdout), JSON.parse(after.stdout));
});

test('CLI: --block-on present with no value is a usage error, not a silent fall back to the default', () => {
  const p = reviewFile({ issue: 620, findings: [finding({ category: 'efficiency' })] });
  for (const args of [[p, '--block-on'], [p, '--block-on='], [p, '--block-on', '--verbose']]) {
    const { code, stdout, stderr } = runCli(args);
    assert.equal(code, 2, `expected a usage error for ${args.join(' ')}`);
    assert.equal(stdout, '');
    assert.match(stderr, /--block-on/);
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

test('CLI: stderr names a self-cleared finding and an unusable blocking value without the operator opening the review', () => {
  // The stderr line is the whole operator surface in a wave summary. A
  // downgrade that only moved `nitCount` reads there as an ordinary nit.
  const p = reviewFile({
    issue: 620,
    findings: [finding({ category: 'convention', blocking: false }), finding({ category: 'contract', blocking: 'false' })],
  });
  const { code, stdout, stderr } = runCli([p]);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.selfClearedCount, 1);
  assert.deepEqual(out.malformedBlocking, ['"false"']);
  assert.match(stderr, /1 self-cleared/);
  assert.match(stderr, /unusable blocking: "false"/);
});

// --- Cross-file enum sync ---------------------------------------------------
//
// `CATEGORIES` is spelled out in four other files, and SKILL.md's "Keep all
// copies in sync when editing" was the only thing holding them together — a
// convention, enforced by nobody. The `convention`/`contract` widening kept
// them in step by hand; the next edit is free not to. A copy that drifts is
// worse than a missing one: the Review subagent is prompted from these files,
// so a stale list tells the reviewer to emit a category the gate then fails
// closed on, bouncing the PR to `/review-loop`, which has no fix for it.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Files outside `review-gate.mjs` that enumerate the categories, and how many
 * enumerations each holds. The counts are pinned so that rewording one list
 * *out of recognition* fails here rather than passing on the strength of the
 * file's other copy.
 */
const ENUM_SITES = {
  'references/review-schema.md': 1, // the `category` line of the JSON block
  'references/retrospective-schema.md': 1, // the inherited-vocabulary sentence
  'SKILL.md': 2, // the Review block: the "Cover ..." prose and the inline enum
  'workflow.js': 2, // the mirrored Review prompt: the same two
};

/** Prose spells `test-coverage` as `test coverage`; both name the same category. */
const SPELLINGS = new Map(
  CATEGORIES.flatMap((c) => (c.includes('-') ? [[c, c], [c.replaceAll('-', ' '), c]] : [[c, c]])),
);

/**
 * Longest alternative first, so `test coverage` never matches as bare
 * `coverage`; escaped, so a category name is data here rather than pattern.
 */
const TOKEN = new RegExp(
  `\\b(?:${[...SPELLINGS.keys()]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})\\b`,
  'g',
);

/**
 * What may sit *between* two members of one enumeration: pipes, commas,
 * whitespace, and a trailing "and". Anything else — a backtick, a quote, a
 * word — ends the run, which doubles as the escape hatch for prose naming
 * categories individually (`` `conventions` for `convention` ``) rather than
 * enumerating them.
 */
const SEPARATOR = /^[\s|,]*(?:and\s+)?$/;

/**
 * A `--block-on` list names the *gate*, which is a chosen subset of the enum
 * (`--block-on correctness,security,contract` is a documented example, not a
 * stale copy of `CATEGORIES`). Dropped before the enumerations are read.
 */
const BLOCK_ON_LIST = /--block-on[= ][a-z][a-z,-]*/g;

/**
 * Every category enumeration in a file: a run of three or more category names
 * joined only by separators, and mentioning `correctness`. Matching on the
 * names present rather than on a sentence keeps this indifferent to how the
 * surrounding prose is worded — only list membership and order are pinned.
 *
 * @param {string} raw  the file's contents
 * @returns {string[][]} each enumeration, in canonical spellings
 */
function categoryLists(raw) {
  const text = raw.replaceAll(BLOCK_ON_LIST, ' ');
  const lists = [];
  let run = [];
  let end = -1;
  for (const hit of text.matchAll(TOKEN)) {
    if (run.length && SEPARATOR.test(text.slice(end, hit.index))) run.push(hit[0]);
    else {
      if (run.length >= 3) lists.push(run);
      run = [hit[0]];
    }
    end = hit.index + hit[0].length;
  }
  if (run.length >= 3) lists.push(run);
  return lists.filter((l) => l.includes('correctness')).map((l) => l.map((n) => SPELLINGS.get(n)));
}

test('categoryLists: reads an enumeration out of prose or a pipe list, and is not fooled by a passing mention', () => {
  // The sync test below is worth exactly what this matcher is worth: if it
  // quietly stopped recognizing lists, the whole guard would pass vacuously.
  assert.deepEqual(
    categoryLists('one of `correctness | security | simplification | efficiency | test-coverage | convention | contract`'),
    [CATEGORIES],
  );
  assert.deepEqual(
    categoryLists('Cover correctness, security, simplification, efficiency, test coverage, convention, and contract.'),
    [CATEGORIES],
  );
  assert.deepEqual(categoryLists('(correctness|security|simplification|efficiency|test-coverage|convention|contract)'), [CATEGORIES]);
  // A stale list is seen, and seen as stale.
  assert.deepEqual(categoryLists('correctness | security | simplification'), [['correctness', 'security', 'simplification']]);
  // Not enumerations: prose that happens to use a category word, the two-name
  // default, and individually quoted names including the alias spellings.
  assert.deepEqual(categoryLists('whether it names a correctness defect or a cosmetic nit'), []);
  assert.deepEqual(categoryLists('--block-on correctness,security'), []);
  // A `--block-on` example names a subset of the enum on purpose, so it is not
  // a copy that can go stale — even when it is long enough to look like one.
  assert.deepEqual(categoryLists('widen it per-run: `--block-on correctness,security,contract`'), []);
  assert.deepEqual(categoryLists('`conventions` for `convention`, `contract-conformance` for `contract`'), []);
});

test('every file that spells the category enum out agrees with CATEGORIES', () => {
  for (const [site, expected] of Object.entries(ENUM_SITES)) {
    const lists = categoryLists(readFileSync(join(REPO_ROOT, site), 'utf8'));
    assert.equal(
      lists.length,
      expected,
      `${site} holds ${lists.length} category enumerations, expected ${expected} — if one was deliberately added or reworded away, update ENUM_SITES`,
    );
    for (const list of lists) {
      assert.deepEqual(
        list,
        CATEGORIES,
        `${site} enumerates ${list.join(', ')}, which is out of sync with CATEGORIES — if this is a deliberate subset rather than a copy of the enum (the five ReportFindings categories, say), name its members individually so the run breaks, e.g. \`correctness\` and \`security\` in backticks`,
      );
    }
  }
});

test('every declaration of the --block-on default agrees with DEFAULT_BLOCK_ON', () => {
  // These spell DEFAULT_BLOCK_ON rather than the enum, but drift for the same
  // reason and at the same cost: an operator — or a reviewer subagent — reading
  // a default the gate does not actually apply.
  //
  // Only declarations *marked* as the default are read. `--block-on
  // correctness,security,contract` appears in review-schema.md as a worked
  // example of widening the gate per-run; an example is not a copy, and pinning
  // every occurrence would fail the moment one is quoted somewhere new.
  const skill = readFileSync(join(REPO_ROOT, 'SKILL.md'), 'utf8');
  const declared = skill
    .split('\n')
    .filter((l) => l.includes('--block-on') && (l.startsWith('argument-hint:') || l.includes('(default)')))
    .map((l) => l.match(/--block-on ([a-z][a-z,-]*)/)?.[1]?.split(','));
  assert.equal(declared.length, 2, 'SKILL.md should declare the default gate in its argument hint and in its flag list');
  for (const hint of declared) assert.deepEqual(hint, DEFAULT_BLOCK_ON);

  // `workflow.js` re-declares the default for the accelerator fallback path and
  // interpolates it into the reviewer's prompt. Unpinned, a change to
  // DEFAULT_BLOCK_ON leaves that path telling a reviewer the gate blocks on
  // categories it no longer blocks on — or omitting ones it now does.
  const workflow = readFileSync(join(REPO_ROOT, 'workflow.js'), 'utf8');
  const fallback = workflow.match(/const blockOn\s*=[^\n]*?\[([^\]]*)\]/);
  assert.ok(fallback, 'workflow.js no longer declares a blockOn fallback');
  assert.deepEqual([...fallback[1].matchAll(/'([^']*)'/g)].map((m) => m[1]), DEFAULT_BLOCK_ON);

  // `references/review-schema.md` is the canonical statement of the gate and
  // the file both prompts point the reviewer at, so it is the worst place of
  // the three for the stated default to drift from the applied one. Located by
  // "defaulting to", which marks the declaration rather than the worked
  // examples of widening the gate per-run that appear later in the file.
  const schema = readFileSync(join(REPO_ROOT, 'references/review-schema.md'), 'utf8');
  const stated = schema
    .split('\n')
    .filter((l) => l.includes('defaulting to `--block-on'))
    .map((l) => l.match(/defaulting to `--block-on ([a-z][a-z,-]*)`/)?.[1]?.split(','));
  assert.equal(stated.length, 1, 'review-schema.md should declare the default gate exactly once');
  assert.deepEqual(stated[0], DEFAULT_BLOCK_ON);
});

// --- The reviewer prompt's `blocking` instruction --------------------------
//
// The axis's only real-world input is the instruction telling the reviewer to
// emit `blocking`; every gate test above supplies the field directly, so the
// suite cannot notice the instruction going missing. It went missing and
// stayed green — stripped from both prompts, all 49 tests passed. The cost is
// silent: a review that omits `blocking` fails toward blocking by design, so
// the axis degrades to "every CONFIRMED finding in a now-widened category
// blocks", and `convention` — 18 emissions across 294 logged findings, mostly
// cosmetic — becomes a merge blocker, which is precisely the outcome widening
// DEFAULT_BLOCK_ON was only safe because this axis prevents.

/** The classify step must name the field and both of the values it may take. */
const EMITS_BLOCKING = /\bblocking\b[:\s]+`?true`?\s*\|\s*`?false`?/;

/** The write step must list `blocking` among the finding object's keys. */
const WRITES_BLOCKING = /\bcategory,\s*verdict,\s*blocking,\s*file,\s*line,\s*summary,\s*failure_scenario\b/;

/** The fail-closed default has to reach the reviewer, not just the gate. */
const OMISSION_FAILS_CLOSED = /omitting it fails toward blocking/;

/**
 * Every copy of the Review subagent's prompt, and the schema it points the
 * reviewer at. `workflow.js` mirrors SKILL.md's block for the fallback path,
 * so an instruction added to one and not the other leaves half the runs
 * emitting the field.
 */
const BLOCKING_INSTRUCTION_SITES = {
  'SKILL.md': [EMITS_BLOCKING, WRITES_BLOCKING, OMISSION_FAILS_CLOSED],
  'workflow.js': [EMITS_BLOCKING, WRITES_BLOCKING, OMISSION_FAILS_CLOSED],
  // The schema block the prompts tell the reviewer to classify against.
  'references/review-schema.md': [/"blocking":\s*(?:true|false)/],
};

/**
 * The reviewer must also be told its `findingCount` is cross-checked against
 * the file. The gate can recompute a verdict from findings it can read; it
 * cannot see a finding that never reached disk, so the reported count is the
 * only witness — and a reviewer that believes the number is cosmetic has no
 * reason to make it accurate. Same shape as the block above, deliberately: a
 * fifth hand-rolled locator idiom in this file is what #48 exists to stop.
 */
const COUNT_IS_CHECKED = /`?findingCount`? is cross-checked against the file/;
const PROMPT_INSTRUCTION_SITES = {
  'SKILL.md': [COUNT_IS_CHECKED],
  'workflow.js': [COUNT_IS_CHECKED],
};

test('every copy of the reviewer prompt still instructs the reviewer to emit blocking', () => {
  for (const [site, patterns] of Object.entries(BLOCKING_INSTRUCTION_SITES)) {
    const raw = readFileSync(join(REPO_ROOT, site), 'utf8');
    for (const pattern of patterns) {
      assert.match(
        raw,
        pattern,
        `${site} no longer instructs the reviewer to emit \`blocking\` (${pattern}) — without it every review omits the field, the gate fails every CONFIRMED finding toward blocking, and the axis is gone with the suite still green`,
      );
    }
  }
});

test('every copy of the reviewer prompt still tells the reviewer its findingCount is checked', () => {
  for (const [site, patterns] of Object.entries(PROMPT_INSTRUCTION_SITES)) {
    const raw = readFileSync(join(REPO_ROOT, site), 'utf8');
    for (const pattern of patterns) {
      assert.match(
        raw,
        pattern,
        `${site} no longer tells the reviewer its findingCount is cross-checked (${pattern}) — the count is the gate's only witness that the findings arrived, and a reviewer told nothing about it has no reason to make it accurate`,
      );
    }
  }
});

/**
 * Step 4d must actually pass the count. The flag being optional is what keeps
 * ad-hoc invocations working; it is also what lets the skill quietly stop
 * supplying it, restoring the exact hazard with every test still green.
 */
test('SKILL.md step 4d passes the reviewer\'s findingCount to the gate', () => {
  const raw = readFileSync(join(REPO_ROOT, 'SKILL.md'), 'utf8');
  // Matched on the literal invocation, not on `review-gate.mjs` + `--block-on`
  // appearing anywhere in a line: step 5's prose contains both strings *and*
  // `--expect-findings`, so the loose locator passed only because step 4d
  // happens to come first. Reorder the file and this test would have silently
  // started asserting about prose while the command itself dropped the flag.
  const lines = raw.split('\n').filter((l) => l.includes('node "$SD/scripts/review-gate.mjs"'));
  assert.equal(lines.length, 1, `expected exactly one literal gate invocation in SKILL.md, found ${lines.length}`);
  const invocation = lines[0];
  assert.ok(invocation, 'SKILL.md no longer shows a review-gate.mjs invocation');
  assert.match(
    invocation,
    /--expect-findings/,
    'step 4d invokes the gate without --expect-findings — the reviewer\'s count is back in the orchestrator\'s hands and discarded, which is how WXYC/Backend-Service#2587 merged past a correctness finding',
  );
});

/**
 * Every prose statement of the blocking predicate, and the phrase that locates
 * it. A statement that drifts is worse than a missing one: SKILL.md step 4d
 * stated the pre-#27 rule verbatim (`category ∈ --block-on` and `verdict ==
 * CONFIRMED`) for the whole of this PR, describing a gate that no longer
 * exists to the one agent whose job is to apply it.
 */
const GATE_RULE_SITES = {
  'SKILL.md': "review-schema.md`'s rule",
  'references/review-schema.md': 'Auto-merge is **blocked**',
  // The escalation trigger restates the rule to decide what reaches a human.
  // It stated the pre-#27 version — "a CONFIRMED finding in a `--block-on`
  // category" — which is now neither necessary nor sufficient: a CONFIRMED
  // `convention` finding the reviewer cleared is in a `--block-on` category
  // and does not block, so the trigger fired on a case the gate merges.
  'references/escalation-policy.md': '**Unclearable blocking finding**',
};

/** The conjuncts `gateReview` actually ANDs together, as the prose spells them. */
const RULE_CONJUNCTS = [/`category ∈ --block-on`/, /`verdict == CONFIRMED`/, /`blocking` is not explicitly `false`/];

test('every prose statement of the gate rule names every conjunct the gate applies', () => {
  for (const [site, locator] of Object.entries(GATE_RULE_SITES)) {
    const statement = readFileSync(join(REPO_ROOT, site), 'utf8')
      .split('\n')
      .find((l) => l.includes(locator));
    assert.ok(statement, `${site} no longer states the gate rule near ${JSON.stringify(locator)} — update GATE_RULE_SITES`);
    for (const conjunct of RULE_CONJUNCTS) {
      assert.match(statement, conjunct, `${site} states the gate rule without ${conjunct}`);
    }
  }
});

// --- The review must actually arrive ------------------------------------
//
// `#25` hardened the gate against a finding it could not classify and `#27`
// against a field value it could not use. Neither can see a finding that never
// arrived. In run sd-20260919-075508, `WXYC%2FBackend-Service%232587.json` is
// the 32-byte literal `{"issue": 2587, "findings": []}` while its `.json.raw`
// sibling holds four findings, the first a correctness defect. The gate scored
// it `clean` and the PR merged. The reviewer's own `findingCount` was in the
// orchestrator's hands the whole time and was discarded.

test('parseExpectFindings: absent is undefined, a count is a number', () => {
  assert.equal(parseExpectFindings(undefined), undefined);
  assert.equal(parseExpectFindings('0'), 0);
  assert.equal(parseExpectFindings('4'), 4);
  assert.equal(parseExpectFindings(' 4 '), 4);
});

test('parseExpectFindings: rejects anything that is not a non-negative integer', () => {
  for (const bad of ['', '  ', '-1', '1.5', 'four', '4x', '1e3', 'NaN', 'Infinity']) {
    assert.throws(() => parseExpectFindings(bad), /expect-findings/, `expected a throw for ${JSON.stringify(bad)}`);
  }
});

test('gateReview: a matching expectation gates exactly as no expectation does', () => {
  const review = { issue: 1, findings: [finding(), finding({ category: 'simplification' })] };
  assert.deepEqual(gateReview(review, DEFAULT_BLOCK_ON, 2), gateReview(review));
});

test('gateReview: a short review is a hard error naming both counts, never a verdict', () => {
  // The #2587 shape: the reviewer reported 4, the file holds 0.
  // Both counts must appear: an operator reading only stderr has to be able to
  // tell a total loss from a partial one without opening the file.
  assert.throws(() => gateReview({ issue: 2587, findings: [] }, DEFAULT_BLOCK_ON, 4), (e) =>
    /reported 4 /.test(e.message) && /holds 0\b/.test(e.message));
  // And the partial-loss shape (#2597: 3 reported, 2 on disk).
  assert.throws(() => gateReview({ issue: 2597, findings: [finding(), finding()] }, DEFAULT_BLOCK_ON, 3), (e) =>
    /reported 3 /.test(e.message) && /holds 2\b/.test(e.message));
});

test('gateReview: a genuinely clean review with a matching expectation of 0 is not collateral', () => {
  const g = gateReview({ issue: 7, findings: [] }, DEFAULT_BLOCK_ON, 0);
  assert.equal(g.verdict, 'clean');
  assert.equal(g.findingCount, 0);
});

test('gateReview: an over-long review is a mismatch too — the invariant is equality, not a floor', () => {
  assert.throws(() => gateReview({ issue: 8, findings: [finding(), finding()] }, DEFAULT_BLOCK_ON, 1), (e) =>
    /reported 1 /.test(e.message) && /holds 2\b/.test(e.message));
});

test('gateFile: carries the expectation through to the same hard error', () => {
  const p = reviewFile({ issue: 2587, findings: [] });
  assert.throws(() => gateFile(p, DEFAULT_BLOCK_ON, 4), (e) =>
    /reported 4 /.test(e.message) && /holds 0\b/.test(e.message));
  assert.equal(gateFile(p, DEFAULT_BLOCK_ON, 0).verdict, 'clean');
});

test('CLI: --expect-findings matching the file gates normally', () => {
  const p = reviewFile({ issue: 620, findings: [finding()] });
  const { code, stdout } = runCli([p, '--expect-findings', '1']);
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).findingCount, 1);
});

test('CLI: --expect-findings mismatching exits 3 and names both counts on stderr', () => {
  const p = reviewFile({ issue: 2587, findings: [] });
  const { code, stdout, stderr } = runCli([p, '--expect-findings', '4']);
  assert.equal(code, 3, stderr);
  assert.equal(stdout, '', 'a refused review must not emit a verdict on stdout');
  assert.match(stderr, /4/);
  assert.match(stderr, /0/);
});

test('CLI: --expect-findings is optional — every existing caller keeps working', () => {
  const p = reviewFile({ issue: 620, findings: [finding()] });
  const { code } = runCli([p]);
  assert.equal(code, 0);
});

test('CLI: a malformed --expect-findings is a usage error (exit 2), not an unreadable review (exit 3)', () => {
  const p = reviewFile({ issue: 620, findings: [finding()] });
  for (const args of [[p, '--expect-findings', 'four'], [p, '--expect-findings', '-1'], [p, '--expect-findings='], [p, '--expect-findings']]) {
    const { code, stderr } = runCli(args);
    assert.equal(code, 2, `expected a usage error for ${args.join(' ')} — got ${code}: ${stderr}`);
  }
});

test('CLI: --expect-findings is positional-independent — its value is never mistaken for the review path', () => {
  // The same defect `--block-on` shipped with: `argv.find((a) => !a.startsWith('--'))`
  // took the flag's value as the path when the flag came first.
  const p = reviewFile({ issue: 620, findings: [finding()] });
  const after = runCli([p, '--expect-findings', '1']);
  const before = runCli(['--expect-findings', '1', p]);
  assert.equal(before.code, 0, before.stderr);
  assert.deepEqual(JSON.parse(before.stdout), JSON.parse(after.stdout));
});

test('gateReview: a string expectation is normalized, not compared raw', () => {
  // A programmatic caller reads the count out of a report JSON or the
  // environment and hands over `'2'`. A bare `!==` against a string fails every
  // time, with the self-contradicting message "reported 2, the file holds 2".
  const review = { issue: 1, findings: [finding(), finding()] };
  assert.equal(gateReview(review, DEFAULT_BLOCK_ON, '2').verdict, gateReview(review).verdict);
  assert.throws(() => gateReview(review, DEFAULT_BLOCK_ON, '3'), (e) =>
    /reported 3 /.test(e.message) && /holds 2\b/.test(e.message));
  // And a malformed one is still rejected rather than silently disabling the check.
  assert.throws(() => gateReview(review, DEFAULT_BLOCK_ON, 'two'), /expect-findings/);
});

test('gateReview: the mismatch message does not claim a shortfall when the file is over-long', () => {
  // The guard is equality, so "review is short" misdirects an operator into
  // hunting a truncated write when the real fault is the reviewer's count.
  let message = '';
  try {
    gateReview({ issue: 1, findings: [finding(), finding()] }, DEFAULT_BLOCK_ON, 1);
  } catch (err) {
    message = err.message;
  }
  assert.doesNotMatch(message, /short/i, `over-long mismatch reported as a shortfall: ${message}`);
  assert.match(message, /mismatch/i);
});
