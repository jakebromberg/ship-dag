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

/**
 * The gate's default categories, matching `references/review-schema.md`.
 * `convention` and `contract` joined this default in #27, discharging the
 * silent-auto-merge obligation #26 deferred: without the new `blocking` axis
 * below, that widening would have promoted every cosmetic `convention` nit to
 * a blocker. With it, a category's default membership only decides which
 * findings are *eligible* to block; the reviewer's own blocking/nit call
 * still decides which of them actually do.
 */
export const DEFAULT_BLOCK_ON = ['correctness', 'security', 'convention', 'contract'];

/**
 * Categories severe enough that a CONFIRMED finding always blocks, immune to
 * the `blocking` axis below. Without this carve-out, a reviewer could mark
 * its own confirmed correctness or security defect a "nit" and clear it —
 * letting the model grade its own homework, exactly what recomputing the
 * gate from `findings[]` (rather than trusting a self-reported verdict)
 * exists to prevent.
 */
export const ALWAYS_BLOCK = ['correctness', 'security'];

/**
 * The finding `category` enum. The first five mirror `/code-review`'s
 * ReportFindings contract exactly; `convention` and `contract` extend past it
 * — logged review data showed both in real use, each under two spellings,
 * with no fix available but widening the enum (see `CATEGORY_ALIASES`).
 */
export const CATEGORIES = [
  'correctness',
  'security',
  'simplification',
  'efficiency',
  'test-coverage',
  'convention',
  'contract',
];

/**
 * Alternate spellings reviewers emit for a canonical category name, mapped to
 * that name. Applied by `normalizeCategory` before every enum membership test
 * — checking membership first would make an aliased spelling fail closed the
 * same as a genuinely unrecognized one, and this map would go dead.
 *
 * A `Map`, not an object literal, because the keys are attacker-shaped strings
 * from a review file: `{}['constructor']` is the `Object` function and
 * `{}['__proto__']` is `Object.prototype`, so a finding categorized
 * `constructor` normalized to a *function*. It still failed the membership
 * test and still blocked, but `JSON.stringify` drops a function outright, so
 * `unknownCategories` reported `null` and `blocking[]` carried no `category`
 * key at all — the gate told the operator nothing about what to fix. A `Map`
 * has no inherited keys to resolve.
 */
export const CATEGORY_ALIASES = new Map([
  ['conventions', 'convention'],
  ['contract-conformance', 'contract'],
]);

/**
 * Normalize a trimmed, lowercased category through `CATEGORY_ALIASES`. A
 * category with no alias passes through unchanged.
 * @param {string} category
 * @returns {string}
 */
export function normalizeCategory(category) {
  return CATEGORY_ALIASES.get(category) ?? category;
}

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
    .map((s) => normalizeCategory(s.trim().toLowerCase()))
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
 *
 * A flag *present with no value* is an error, not an absent flag. The two are
 * distinguishable, and conflating them is the same silent narrowing: an
 * operator who typed `--block-on` and lost the list would get the default gate
 * and no signal at all.
 *
 * @param {string[]} argv
 * @param {string} flag
 * @returns {string|undefined} the value, or undefined when the flag is absent
 * @throws {Error} when the flag is present but carries no value
 */
export function readFlag(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq !== undefined) {
    const value = eq.slice(flag.length + 1);
    if (!value) throw new Error(`${flag} was given with no value`);
    return value;
  }
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} was given with no value`);
  return value;
}

/**
 * The positional argument, skipping every `--flag` *and* the value a
 * space-separated one consumes. Scanning for "the first argv entry that isn't a
 * `--flag`" took `--block-on correctness,security review.json`'s list as the
 * review path and died `ENOENT` — exit 3, "unreadable review", for what is
 * plainly a malformed invocation.
 *
 * @param {string[]} argv
 * @param {string[]} [valueFlags]  flags whose space-separated form takes a value
 * @returns {string|undefined}
 */
export function readPositional(argv, valueFlags = []) {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) return a;
    // `--flag=value` carries its own value; `--flag value` eats the next entry.
    if (valueFlags.includes(a)) i += 1;
  }
  return undefined;
}

/**
 * Recompute the merge gate from a review object.
 *
 * A finding blocks iff its `category` is in `blockOn` AND its `verdict` is
 * CONFIRMED AND — for a category outside `ALWAYS_BLOCK` — its own `blocking`
 * field is not explicitly `false` — **or** its `category` is outside
 * `CATEGORIES` (including blank/absent) at all. That third clause is the
 * reviewer's own blocking/nit call, ANDed onto the category test rather than
 * trusted alone: it narrows which findings in a widened category actually
 * block, but can never by itself clear one, and a finding that omits
 * `blocking` fails toward blocking — the same fail-closed rule an
 * unrecognized category follows. An unrecognized category is the same hazard
 * as a truncated `findings` array with a quieter failure mode: the gate
 * cannot know whether it names a correctness defect or a cosmetic nit, so it
 * fails closed rather than defaulting to "nit". Everything else (PLAUSIBLE
 * findings in a known, non-blocking category) is counted and surfaced but
 * does not block.
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
  // Normalized, not merely lowercased, and by the same function the finding
  // side uses: the CLI runs `blockOn` through `parseBlockOn` first, but a
  // programmatic caller passing `['contract-conformance']` reaches here raw,
  // and an un-normalized gate would then match no finding at all — the silent
  // narrowing `parseBlockOn` exists to prevent.
  const gate = new Set(blockOn.map((c) => normalizeCategory(String(c).trim().toLowerCase())));
  // Two lists, concatenated for the listed window: a reviewer who coins three
  // category names would otherwise push the real defects out of `blocking[≤3]`,
  // which is the only list the operator reads in a wave summary.
  const byRule = [];
  const byTaxonomy = [];
  const unknown = new Set();
  let nitCount = 0;
  for (const f of review.findings) {
    // Trimmed as well as lowercased, symmetrically with `parseBlockOn`: a
    // trailing space is transcription noise, not a different category, and
    // reporting `"correctness "` as unknown gave the operator nothing to act on.
    const category = normalizeCategory(String(f?.category ?? '').trim().toLowerCase());
    const known = Boolean(category) && CATEGORIES.includes(category);
    if (!known) unknown.add(category || '(blank)');
    const confirmed = String(f?.verdict ?? '').toUpperCase() === 'CONFIRMED';
    // One line each: enough for the human to recognize the defect in a wave
    // summary or a grill, without lifting the prose into context wholesale.
    // Every field is `?? null` — `JSON.stringify` drops an `undefined` value
    // outright, so the operator would get an entry missing that key entirely —
    // and `category` reports the same normalized value `unknownCategories[]`
    // does, rather than two spellings of one finding.
    const entry = {
      category: category || null,
      file: f?.file ?? null,
      line: f?.line ?? null,
      summary: f?.summary ?? null,
    };
    // The reviewer's own blocking/nit call, only able to narrow a category
    // ALWAYS_BLOCK doesn't already force — a CONFIRMED correctness or
    // security finding blocks no matter what it says here.
    const selfNit = f?.blocking === false && !ALWAYS_BLOCK.includes(category);
    if (!known) byTaxonomy.push(entry);
    else if (gate.has(category) && confirmed && !selfNit) byRule.push(entry);
    else nitCount += 1;
  }
  const blockingCount = byRule.length + byTaxonomy.length;
  return {
    issue: review.issue ?? null,
    verdict: blockingCount ? 'blocking' : review.findings.length ? 'nits-only' : 'clean',
    blockingCount,
    nitCount,
    findingCount: review.findings.length,
    blocking: [...byRule, ...byTaxonomy].slice(0, MAX_LISTED),
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
  const path = readPositional(argv, ['--block-on']);
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
  // JSON-quoted so a coined multi-word category (`test quality`) or one
  // carrying punctuation reads as the single literal string the reviewer wrote,
  // rather than as bare prose the operator scans straight past.
  const unknown = out.unknownCategories.length
    ? `; unknown categories: ${out.unknownCategories.map((c) => JSON.stringify(c)).join(', ')}`
    : '';
  process.stderr.write(`review-gate: #${out.issue} ${out.verdict} — ${out.blockingCount} blocking, ${out.nitCount} nits${unknown}\n`);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
