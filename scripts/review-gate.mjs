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
//   node review-gate.mjs <review.json> [--block-on correctness,security] [--expect-findings N]
//   node review-gate.mjs <review.json> [--block-on=correctness,security] [--expect-findings=N]
// Prints the gate decision as JSON on stdout and a one-line summary on stderr.
// Exit 2 on a malformed invocation — a `--block-on` naming a category outside
// `CATEGORIES`, a non-integer `--expect-findings`, a flag with no value — and 3
// on a review that cannot be scored: unreadable, no `findings` array, or a
// finding count disagreeing with what the reviewer reported writing.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
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
 *
 * The carve-out is applied *within* the `--block-on` test, not around it: it
 * stops `blocking` narrowing the gate, it does not widen the gate past the
 * list the operator gave. An operator who narrows `--block-on` to a single
 * category still gets exactly that category, as they always did.
 *
 * Every member must be a canonical `CATEGORIES` spelling *and* a member of
 * `DEFAULT_BLOCK_ON` — a carve-out naming a category the default gate does
 * not block is inert by default, and one naming a non-canonical spelling
 * never matches, since the gate tests it after `normalizeCategory`. Both are
 * pinned by an invariant test rather than left to the three lists agreeing by
 * hand.
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
 * How many characters of an unusable `blocking` value are echoed back. This
 * script exists to keep a per-PR merge decision to a few hundred bytes, and
 * the value is reviewer-authored: `blocking: { why: "<three paragraphs>" }`
 * would otherwise spend that whole budget twice, once on stdout and once on
 * the stderr summary line. Wide enough for `"false"`, `0`, or `null` — the
 * spellings actually seen — to arrive whole.
 */
export const MAX_VALUE_CHARS = 40;

/**
 * Render an unusable `blocking` value for the operator: its JSON text, so
 * `"false"` reads as the string the reviewer wrote and `0` as the number,
 * truncated to `MAX_VALUE_CHARS`. Falls back to `String` for a value
 * `JSON.stringify` has no text for (a function, from a programmatic caller).
 * @param {unknown} value
 * @returns {string}
 */
export function renderUnusable(value) {
  const raw = JSON.stringify(value) ?? String(value);
  return raw.length > MAX_VALUE_CHARS ? `${raw.slice(0, MAX_VALUE_CHARS)}…` : raw;
}

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
 * Parse `--expect-findings`: the count the Review subagent reported writing.
 *
 * Absent is `undefined` — the flag is optional, so existing callers, tests and
 * ad-hoc operator invocations keep working and only the skill supplies it.
 * Anything present must be a non-negative integer; a malformed value throws so
 * `main()` can exit 2 (the operator's mistake) rather than silently dropping
 * the check and restoring the very hazard the flag exists to close.
 *
 * @param {string|undefined|null} raw
 * @returns {number|undefined}
 */
export function parseExpectFindings(raw) {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  // `Number()` accepts '', '1e3', 'Infinity' and ' 4 '; only the last is meant.
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`--expect-findings must be a non-negative integer, got ${renderUnusable(trimmed)}`);
  }
  return Number(trimmed);
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

/** A PR as a merge-order note names it: `owner/repo#N`, with no leading zero (`#0100` would slip past the self check). */
const PR_REF = /^[^\s/#]+\/[^\s/#]+#[1-9]\d*$/;

/**
 * Whether a finding's `mergeOrder` is a usable note: an object with a PR `with` and a non-blank
 * `obligation`. Validated, not coerced, since a usable note is merge-ward.
 * @param {unknown} note
 */
export function isMergeOrder(note) {
  return (
    Boolean(note) &&
    typeof note === 'object' &&
    typeof note.with === 'string' &&
    PR_REF.test(note.with) &&
    typeof note.obligation === 'string' &&
    note.obligation.trim() !== ''
  );
}

/** Whether `withRef` is in the issue's repo and not the issue itself; with no issue ref, never. */
function siblingOf(withRef, issueRef) {
  const own = typeof issueRef === 'string' ? PR_REF.exec(issueRef) && issueRef.toLowerCase() : null;
  const other = withRef.toLowerCase();
  return Boolean(own) && other.split('#')[0] === own.split('#')[0] && other !== own;
}

/** The issue ref a round file is named for (`artifactStem`), the one source of the issue's repo the gate trusts. */
export function issueRefFromPath(path) {
  try {
    const m = /^([^\s/#]+\/[^\s/#]+#\d+)(?:[.-][A-Za-z0-9-]+)?\.json$/.exec(decodeURIComponent(basename(String(path))));
    return m?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Recompute the merge gate from a review object.
 *
 * A finding blocks iff its `category` is in `blockOn` AND its `verdict` is
 * CONFIRMED AND — for a category outside `ALWAYS_BLOCK` — its own `blocking`
 * field is not explicitly `false` — **or** its `category` is outside
 * `CATEGORIES` (including blank/absent) at all. The `blocking` conjunct is
 * the reviewer's own blocking/nit call, ANDed onto the category test rather than
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
 * `blocking` is **validated, not coerced**: only a JSON boolean is a usable
 * value. A finding that omits it fails toward blocking, as documented; a
 * finding carrying something else (`"false"`, `"no"`, `0`, `null`) also fails
 * toward blocking *and* has that value named in `malformedBlocking[]`, rather
 * than being ignored in silence. Coercing instead would mean guessing which
 * junk values the reviewer meant as a clearance, in the one direction that
 * merges code.
 *
 * `malformedBlocking[]` reports only the values that would have decided
 * something — a CONFIRMED finding in a gated category outside `ALWAYS_BLOCK`,
 * the one position where a boolean `false` would have cleared it. A
 * `blocking` of `0` on a PLAUSIBLE finding changed no outcome, and reporting
 * it would train the operator to skim past the field; it is the same
 * principle `selfCleared[]` applies. Rendered through `renderUnusable` and
 * capped at `MAX_LISTED`, because the value is reviewer-authored text in a
 * result measured in hundreds of bytes.
 *
 * When the axis does clear a CONFIRMED finding, that is recorded in
 * `selfClearedCount` and `selfCleared[≤MAX_LISTED]`. Folded into `nitCount`
 * alone, the result would be bit-identical to a review that merely had a
 * PLAUSIBLE nit, and the one thing about this axis that deserves an
 * operator's scrutiny — the reviewer downgrading its own CONFIRMED finding —
 * would leave no trace, where the other fail-closed path leaves
 * `unknownCategories[]`.
 *
 * A usable `mergeOrder` (`isMergeOrder`, and its `with` in the issue's own repo
 * but not the issue itself; `issueRef` is the issue's `owner/repo#N`, without
 * which no note is usable) is counted in `mergeOrderCount`, listed in
 * `mergeOrder[≤MAX_LISTED]` and, where it clears a finding, in
 * `mergeOrderClearedCount`; a note present but unusable, or refused for its
 * finding, is named in `malformedMergeOrder[]`. What a note may clear is
 * `references/review-schema.md`'s rule.
 *
 * Throws when `findings` is not an array. That is deliberately fatal rather
 * than defaulted to `[]`: a truncated or half-written review file would
 * otherwise read as "nothing wrong" and auto-merge, which is the single most
 * expensive way this gate can be wrong.
 *
 * @param {{issue?: number, findings: object[]}} review
 * @param {string[]} [blockOn]
 * @param {number} [expectFindings]  the count the reviewer reported writing; a
 *   disagreement throws rather than yielding a verdict
 * @param {string} [issueRef]  the issue's `owner/repo#N`, from `issueRefFromPath`
 */
export function gateReviewAll(review, blockOn = DEFAULT_BLOCK_ON, expectFindings = undefined, issueRef = undefined) {
  if (!review || !Array.isArray(review.findings)) {
    throw new Error('review has no findings array — refusing to treat an unreadable review as clean');
  }
  // The findings have to have *arrived*. The reviewer reports how many it
  // wrote; this is the only place those two numbers meet. A file that reaches
  // disk short — or empty — otherwise reads as a clean PR and auto-merges,
  // which is how WXYC/Backend-Service#2587 shipped past a correctness finding
  // its `.json.raw` sibling still holds. Checked before anything is computed:
  // the cause of the drop is not recoverable and does not need to be, and a
  // review we are going to refuse should not be scored first.
  // Normalized here, not only in `main()`: a programmatic caller reading the
  // count out of a report JSON or the environment hands over `'4'`, and a bare
  // `!==` against a string fails every time with the self-contradicting message
  // "reported 4 finding(s), the file holds 4".
  const expected = parseExpectFindings(expectFindings === undefined ? undefined : String(expectFindings));
  if (expected !== undefined && review.findings.length !== expected) {
    throw new Error(
      `finding count mismatch: the reviewer reported ${expected} finding(s), the file holds ${review.findings.length} — ` +
        'refusing to gate a review whose contents and reported count disagree; re-run the reviewer rather than repairing the file',
    );
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
  // The findings the reviewer's own `blocking: false` cleared, and the
  // `blocking` values that were present but unusable. Both are reported;
  // neither changes a count.
  const selfCleared = [];
  const unknown = new Set();
  const malformed = new Set();
  const mergeOrder = [];
  const malformedMergeOrder = new Set();
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
      verdict: String(f?.verdict ?? '').toUpperCase() || null,
      file: f?.file ?? null,
      line: f?.line ?? null,
      summary: f?.summary ?? null,
    };
    // What a note may clear is the schema's rule.
    const note = f?.mergeOrder;
    const wouldBlock = !known || (gate.has(category) && confirmed);
    if (isMergeOrder(note) && siblingOf(note.with, issueRef)) {
      if (!wouldBlock || (known && !ALWAYS_BLOCK.includes(category))) {
        mergeOrder.push({ ...entry, cleared: wouldBlock, with: note.with, obligation: note.obligation });
        continue;
      }
    }
    if (note !== undefined && note !== null) malformedMergeOrder.add(renderUnusable(note));
    // The reviewer's own blocking/nit call, only able to narrow a category
    // ALWAYS_BLOCK doesn't already force — a CONFIRMED correctness or
    // security finding blocks no matter what it says here.
    //
    // Validated rather than coerced, unlike its neighbours above: `verdict`
    // and `category` coerce because any string they carry is *some* claim the
    // gate can score, where `blocking` has exactly two usable values and
    // anything else is the reviewer failing to answer the question. Coercing
    // would mean guessing whether `"false"` or `0` was meant as a clearance,
    // in the one direction that merges code. So a non-boolean is treated as
    // absent — it blocks — and is named in `malformedBlocking[]` so the
    // operator sees the reviewer emitted something the gate could not use,
    // rather than having it ignored in silence.
    const claimed = f?.blocking;
    // The one position where the axis decides anything: a CONFIRMED finding
    // in a gated category that `ALWAYS_BLOCK` does not already force. Both
    // the clearance and the report of an unusable value are scoped to it —
    // a `blocking` the gate would have ignored anyway is not news.
    const clearable = known && gate.has(category) && confirmed && !ALWAYS_BLOCK.includes(category);
    if (clearable && claimed !== undefined && typeof claimed !== 'boolean') malformed.add(renderUnusable(claimed));
    // `claimed === false` already implies a usable value, so no separate
    // check: an unusable one falls through to blocking, as an omitted one does.
    const selfNit = clearable && claimed === false;
    if (!known) byTaxonomy.push(entry);
    else if (gate.has(category) && confirmed) {
      if (selfNit) {
        // Counted as a nit, as before — but no longer *only* as a nit, or the
        // result would be indistinguishable from a review that had a
        // PLAUSIBLE nit and no downgrade at all.
        selfCleared.push(entry);
        nitCount += 1;
      } else byRule.push(entry);
    } else nitCount += 1;
  }
  const blockingCount = byRule.length + byTaxonomy.length;
  return {
    issue: review.issue ?? null,
    verdict: blockingCount ? 'blocking' : review.findings.length ? 'nits-only' : 'clean',
    blockingCount,
    nitCount,
    selfClearedCount: selfCleared.length,
    findingCount: review.findings.length,
    blocking: [...byRule, ...byTaxonomy].slice(0, MAX_LISTED),
    allBlocking: [...byRule, ...byTaxonomy],
    selfCleared: selfCleared.slice(0, MAX_LISTED),
    unknownCategories: [...unknown],
    malformedBlocking: [...malformed].slice(0, MAX_LISTED),
    mergeOrderCount: mergeOrder.length,
    mergeOrderClearedCount: mergeOrder.filter((n) => n.cleared).length,
    // Clearances first, so the cap never hides one.
    mergeOrder: [...mergeOrder.filter((n) => n.cleared), ...mergeOrder.filter((n) => !n.cleared)].slice(0, MAX_LISTED),
    malformedMergeOrder: [...malformedMergeOrder].slice(0, MAX_LISTED),
  };
}

/** `gateReviewAll` without the uncapped `allBlocking` list, which the printed result and a caller's JSON never carry. */
export function gateReview(...args) {
  const { allBlocking, ...result } = gateReviewAll(...args);
  return result;
}

/**
 * Gate a review file, carrying its path through so the caller can hand a human
 * (or `/review-loop`) the full findings without ever reading them itself.
 * @param {string} path
 * @param {string[]} [blockOn]
 * @param {number} [expectFindings]
 */
export function gateFile(path, blockOn = DEFAULT_BLOCK_ON, expectFindings = undefined) {
  const review = JSON.parse(readFileSync(path, 'utf8'));
  return { ...gateReview(review, blockOn, expectFindings, issueRefFromPath(path)), path };
}

function main(argv) {
  // Both value-taking flags are declared, or `--expect-findings 4 review.json`
  // would take `4` as the review path — the defect `--block-on` shipped with.
  const path = readPositional(argv, ['--block-on', '--expect-findings']);
  if (!path) {
    process.stderr.write(
      'usage: review-gate.mjs <review.json> [--block-on correctness,security] [--expect-findings N]\n',
    );
    process.exit(2);
  }
  // Parsed outside the gate's try/catch so a bad invocation exits 2 (the
  // operator's mistake) rather than 3 (an unreadable review).
  let blockOn;
  let expectFindings;
  try {
    blockOn = parseBlockOn(readFlag(argv, '--block-on'));
    expectFindings = parseExpectFindings(readFlag(argv, '--expect-findings'));
  } catch (err) {
    process.stderr.write(`review-gate: ${err.message}\n`);
    process.exit(2);
  }
  let out;
  try {
    out = gateFile(path, blockOn, expectFindings);
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
  // The axis's one merge-ward direction, on the same line as the counts: a
  // CONFIRMED finding the reviewer downgraded itself is the case an operator
  // is most likely to want to second-guess, and `nitCount` alone hides it.
  const cleared = out.selfClearedCount ? `; ${out.selfClearedCount} self-cleared (CONFIRMED, blocking: false)` : '';
  // Already JSON text, so not re-quoted — `"false"` reads as the string the
  // reviewer wrote, `0` as the number.
  const malformed = out.malformedBlocking.length ? `; unusable blocking: ${out.malformedBlocking.join(', ')}` : '';
  // Named by the PR each waits on (SKILL.md step 6.2 reads the files again).
  const notes = out.mergeOrderCount
    ? `; ${out.mergeOrderCount} merge-order${out.mergeOrderClearedCount ? ` (${out.mergeOrderClearedCount} cleared a blocking finding)` : ''}: ${out.mergeOrder.map((n) => n.with).join(', ')}`
    : '';
  const badNotes = out.malformedMergeOrder.length ? `; unusable mergeOrder: ${out.malformedMergeOrder.join(', ')}` : '';
  process.stderr.write(
    `review-gate: #${out.issue} ${out.verdict} — ${out.blockingCount} blocking, ${out.nitCount} nits${cleared}${notes}${unknown}${malformed}${badNotes}\n`,
  );
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
