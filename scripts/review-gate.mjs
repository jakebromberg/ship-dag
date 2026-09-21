#!/usr/bin/env node
// review-gate.mjs — recompute SKILL.md step 5's merge gate from the findings
// the Review subagent wrote to disk.
//
// Two problems, one fix.
//
//   1. **Cost.** The Review block used to return its whole
//      `references/review-schema.md` object inline, so every finding landed in
//      main-session context and stayed there for the rest of the run — ~5k
//      tokens for 13 findings on a single PR in run sd-20260831-162148, most of
//      which the main agent never needed, since its only job at step 5 is to
//      gate on `verdict` and the `--block-on` categories. The subagent now
//      writes the full object to `$STATE/reviews/<encoded-ref>.json` and returns
//      a summary; this script turns that file into the gate decision, a few
//      hundred bytes at a time. The full findings stay one `path` away for the
//      moment they are actually needed (routing to `/review-loop`, or reporting
//      to a human).
//
//   2. **Trust.** Once the main agent stops reading the findings, taking the
//      subagent's self-reported `verdict` at face value would make a merge
//      decision rest on a model's claim about its own output. So the claimed
//      verdict is ignored outright: the gate is recomputed here from
//      `findings[]` and `--block-on`, deterministically. This is strictly
//      stronger than the old inline path, where nothing recomputed it at all.
//
// Usage:
//   node review-gate.mjs <review.json> [--block-on correctness,security]
//   node review-gate.mjs <review.json> [--block-on=correctness,security]
// Prints the gate decision as JSON on stdout and a one-line summary on stderr.
// Exit 2 on a malformed invocation — including a `--block-on` naming a category
// outside `CATEGORIES` — and 3 on an unreadable or malformed review.

import { readFileSync } from 'node:fs';
import { isMain } from './lib/is-main.mjs';

/** The gate's default categories, matching `references/review-schema.md`. */
export const DEFAULT_BLOCK_ON = ['correctness', 'security'];

/** The finding `category` enum, mirroring `/code-review`'s ReportFindings contract exactly. */
export const CATEGORIES = ['correctness', 'security', 'simplification', 'efficiency', 'test-coverage'];

/** How many blocking findings the summary lists inline. The count is always exact; the rest are one `path` away. */
export const MAX_LISTED = 3;

/**
 * Parse a `--block-on` list. An absent or empty value means the default gate —
 * never an empty list, which would silently disable blocking entirely.
 *
 * Every member must be in `CATEGORIES`. A category no finding can ever carry
 * is not a stricter gate, it is a *narrower* one that looks stricter: before
 * this check, `--block-on test-quality` matched nothing, so the gate quietly
 * fell back to nothing at all and auto-merged a CONFIRMED correctness defect.
 * Failing loudly here is the same fail-closed rule the finding side applies.
 *
 * @param {string|undefined|null} raw
 * @returns {string[]}
 * @throws {Error} when any member is outside `CATEGORIES`
 */
export function parseBlockOn(raw) {
  if (raw === undefined || raw === null) return DEFAULT_BLOCK_ON;
  const parts = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) return DEFAULT_BLOCK_ON;
  const unknown = parts.filter((c) => !CATEGORIES.includes(c));
  if (unknown.length) {
    throw new Error(
      `--block-on names ${unknown.map((c) => JSON.stringify(c)).join(', ')}, which no finding can carry; ` +
        `the categories are exactly ${CATEGORIES.join(', ')}`,
    );
  }
  return parts;
}

/**
 * Read a `--flag value` / `--flag=value` option out of argv. Both spellings are
 * accepted deliberately: `indexOf('--flag')` alone ignored the equals form, so
 * an operator who widened the gate with `--block-on=...` silently got the
 * narrower default instead of an error.
 * @param {string[]} argv
 * @param {string} flag
 * @returns {string|undefined} the value, or undefined when the flag is absent
 */
export function readFlag(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq !== undefined) return eq.slice(flag.length + 1);
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * Recompute the merge gate from a review object.
 *
 * A finding blocks iff its `category` is in `blockOn` AND its `verdict` is
 * CONFIRMED — exactly `references/review-schema.md`'s rule — **or** its
 * `category` is outside `CATEGORIES` (including blank/absent) at all. An
 * unrecognized category is the same hazard as a truncated `findings` array
 * with a quieter failure mode: the gate cannot know whether it names a
 * correctness defect or a cosmetic nit, so it fails closed rather than
 * defaulting to "nit". Everything else (PLAUSIBLE findings in a known,
 * non-blocking category) is counted and surfaced but does not block.
 *
 * Throws when `findings` is not an array. That is deliberately fatal rather
 * than defaulted to `[]`: a truncated or half-written review file would
 * otherwise read as "nothing wrong" and auto-merge, which is the single most
 * expensive way this gate can be wrong.
 *
 * @param {{issue?: number, findings: object[]}} review
 * @param {string[]} [blockOn]
 */
export function gateReview(review, blockOn = DEFAULT_BLOCK_ON) {
  if (!review || !Array.isArray(review.findings)) {
    throw new Error('review has no findings array — refusing to treat an unreadable review as clean');
  }
  const gate = new Set(blockOn.map((c) => c.toLowerCase()));
  const blocking = [];
  const unknown = new Set();
  let nitCount = 0;
  for (const f of review.findings) {
    // Trimmed as well as lowercased, symmetrically with `parseBlockOn`: a
    // trailing space is transcription noise, not a different category, and
    // reporting `"correctness "` as unknown gave the operator nothing to act on.
    const category = String(f?.category ?? '').trim().toLowerCase();
    const known = category && CATEGORIES.includes(category);
    if (!known) unknown.add(category || '(blank)');
    const confirmed = String(f?.verdict ?? '').toUpperCase() === 'CONFIRMED';
    if (!known || (gate.has(category) && confirmed)) blocking.push(f);
    else nitCount += 1;
  }
  return {
    issue: review.issue ?? null,
    verdict: blocking.length ? 'blocking' : review.findings.length ? 'nits-only' : 'clean',
    blockingCount: blocking.length,
    nitCount,
    findingCount: review.findings.length,
    // One line each: enough for the human to recognize the defect in a wave
    // summary or a grill, without lifting the prose into context wholesale.
    blocking: blocking.slice(0, MAX_LISTED).map((f) => ({
      // `?? null` like its siblings: a blank/absent category now reaches this
      // projection, and `JSON.stringify` drops an `undefined` value outright —
      // the operator would get an entry with no `category` key at all.
      category: f.category ?? null,
      file: f.file ?? null,
      line: f.line ?? null,
      summary: f.summary ?? null,
    })),
    unknownCategories: [...unknown],
  };
}

/**
 * Gate a review file, carrying its path through so the caller can hand a human
 * (or `/review-loop`) the full findings without ever reading them itself.
 * @param {string} path
 * @param {string[]} [blockOn]
 */
export function gateFile(path, blockOn = DEFAULT_BLOCK_ON) {
  const review = JSON.parse(readFileSync(path, 'utf8'));
  return { ...gateReview(review, blockOn), path };
}

function main(argv) {
  const path = argv.find((a) => !a.startsWith('--'));
  if (!path) {
    process.stderr.write('usage: review-gate.mjs <review.json> [--block-on correctness,security]\n');
    process.exit(2);
  }
  // Parsed outside the gate's try/catch so a bad invocation exits 2 (the
  // operator's mistake) rather than 3 (an unreadable review).
  let blockOn;
  try {
    blockOn = parseBlockOn(readFlag(argv, '--block-on'));
  } catch (err) {
    process.stderr.write(`review-gate: ${err.message}\n`);
    process.exit(2);
  }
  let out;
  try {
    out = gateFile(path, blockOn);
  } catch (err) {
    process.stderr.write(`review-gate: ${err.message}\n`);
    process.exit(3);
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  // JSON-quoted so a category carrying whitespace or punctuation is legible as
  // the literal string the reviewer wrote, not as bare prose the operator would
  // read straight past.
  const unknown = out.unknownCategories.length
    ? `; unknown categories: ${out.unknownCategories.map((c) => JSON.stringify(c)).join(', ')}`
    : '';
  process.stderr.write(`review-gate: #${out.issue} ${out.verdict} — ${out.blockingCount} blocking, ${out.nitCount} nits${unknown}\n`);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
