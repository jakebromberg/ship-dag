# Review finding schema & the `--block-on` gate

The Opus review subagent returns findings in a **fixed schema** so the merge gate is defined in the tool's own vocabulary — never an invented High/Medium/Low severity (the built-in `/code-review`'s `ReportFindings` has no severity field, so thresholding on one is meaningless). `category` alone turned out not to be enough of a vocabulary: two findings in the same category can differ in whether they should actually block (#27), and the fix is still not a severity scale — it is `blocking`, the reviewer's own per-finding blocking/nit call, which is the tool's own vocabulary rather than a new one and is ANDed onto `category`/`verdict` rather than trusted alone (see *The gate* below).

## Per-issue review result

```json
{
  "issue": 123,
  "findings": [
    {
      "category": "correctness | security | simplification | efficiency | test-coverage | convention | contract",
      "verdict":  "CONFIRMED | PLAUSIBLE",
      "blocking": true,
      "file":     "path/to/file.ts",
      "line":     42,
      "summary":  "one-sentence statement of the defect",
      "failure_scenario": "concrete inputs/state → wrong output/crash"
    }
  ]
}
```

`verdict` mirrors the built-in `/code-review` `ReportFindings` contract exactly. `category` no longer does: `convention` and `contract` were added on top of the five `ReportFindings` categories, because logged review data showed reviewers emitting both — each under two spellings — with no fix available but widening the enum (see *The gate* below). The optional augmentation (unioning `/code-review` output into `findings[]`) still needs no translation, because the five `ReportFindings` categories are a subset of this enum and each is recognized as written. A `/code-review` finding whose category falls **outside** this enum gets no special case: it is normalized through the alias map, fails the membership test like any other unrecognized category, is named in `unknownCategories[]`, and blocks the merge. That is the specified behavior rather than an unreachable one — the gate does not assume what an external tool emits, so a `ReportFindings` contract that gains a category tomorrow costs one bounce, not a silent auto-merge.

`blocking` is new in #27 and has no `ReportFindings` counterpart at all: it is the reviewer's own blocking/nit call for *this finding*, not for its category — two `test-coverage` findings can differ, one a real defect and one a documentary test case. It only ever narrows: it cannot make a `category` outside `--block-on` block, and (see *The gate*) it cannot clear a CONFIRMED `correctness` or `security` finding either. It is **validated, not coerced**: only a JSON `true` or `false` is a usable value. A finding that omits it is treated as `blocking: true` — the same fail-closed default an unrecognized category gets — and a finding carrying anything else (`"false"`, `"no"`, `0`, `null`) is treated the same way *and* has that value named in `malformedBlocking[]`, because guessing which junk value the reviewer meant as a clearance would be guessing in the one direction that merges code.

## Where the object lives

The Review subagent **writes this object to a file** (`$STATE/reviews/<stem>.json` for round 1 and `<stem>.r<N>.json` after it, with `<stem>` = `artifactStem(ref)`; path supplied by the main agent, see SKILL.md step 4d), with a `meta: { trigger, reportId }` beside `findings` (`trigger` is `initial`, `review-loop` or `rebase`; `reportId` is the stem of the report whose row's PR the round reviews; both supplied by the main agent; the gate ignores them, `ingest-wave` only warns when `trigger` disagrees with the previous round's verdict, and it assigns a round with a `reportId` to that report's wave whatever its mtime, keeping the mtime window for a round without one), and returns only `{ issue, path, findingCount, headline }`. **`findingCount` is load-bearing, not cosmetic**: every invocation of the gate passes it back as `--expect-findings`, and a disagreement with the file is a hard error rather than a verdict. Returning the findings inline instead parks every one of them in main-session context for the rest of the run — ~5k tokens for 13 findings on one PR in run sd-20260831-162148, when the gate needs only a verdict and a count. The findings are read back at the two moments they are actually used: routing a blocking PR to `/review-loop`, and showing a human what was found.

Because of that, the envelope no longer carries an overall `verdict` from the subagent. `scripts/review-gate.mjs` recomputes it from `findings[]`:

```
node scripts/review-gate.mjs <review.json> --block-on correctness,security --expect-findings <N>
→ { issue, verdict, blockingCount, nitCount, selfClearedCount, findingCount, blocking[≤3], selfCleared[≤3], unknownCategories[], malformedBlocking[], path }
```

A merge decision must not rest on a model's claim about its own output, and a review file with no `findings` array is a hard error rather than a silent `clean` — a truncated write must never auto-merge. The same applies to a file that arrives *short*: the gate can recompute a verdict from findings it can read, but it cannot see a finding that never reached disk, so `--expect-findings` is what closes that half. A count disagreement exits 3 with both numbers named, and the remedy is re-running the reviewer — never repairing the file, which is the likeliest way a short one is produced.

## The gate

`--block-on` is a comma-separated list of **categories**, defaulting to `--block-on correctness,security,convention,contract`. Auto-merge is **blocked** for an issue when its review has **any finding whose `category ∈ --block-on` AND `verdict == CONFIRMED` AND `blocking` is not explicitly `false`** — **or any finding whose `category` is not one of the categories listed above, blank, or absent**. An unrecognized category is the same hazard as a missing `findings` array with a quieter failure mode: the gate cannot tell whether it names a correctness defect or a cosmetic nit, so it fails closed rather than defaulting to "nit". `unknownCategories[]` names every offending category (or `(blank)`) so an operator can act without opening the review file. Everything else (PLAUSIBLE findings in a known, non-blocking category, or a `blocking: false` finding in a category that isn't `correctness`/`security`) is surfaced but does **not** block.

`blocking` narrows, never widens: for `correctness` and `security` — the two categories the gate has always trusted on `verdict` alone — a CONFIRMED finding blocks regardless of what `blocking` says, so a reviewer cannot wave off its own confirmed defect as a nit. That carve-out is applied *inside* the `--block-on` test, not around it: it stops `blocking` narrowing the operator's gate, it does not widen the gate past the list the operator gave, so `--block-on convention` still gates on `convention` alone exactly as it did before #27. For every other blocked category, `blocking: false` moves a CONFIRMED finding into the nit count instead of the blocking count; omitting the field blocks, the same fail-closed default an unrecognized category gets.

That move is the axis's only merge-ward direction, so it is never silent: every CONFIRMED finding the reviewer cleared this way is counted in `selfClearedCount` and listed in `selfCleared[≤3]`, the counterpart to `unknownCategories[]` on the other fail-closed path. Without it a downgraded CONFIRMED finding is bit-identical to a PLAUSIBLE nit, and the one thing about this axis worth an operator's scrutiny leaves no trace. A `blocking` value that is present but not a boolean is not a usable clearance: the finding blocks and the value is named in `malformedBlocking[]`.

Two categories have alternate spellings reviewers use in practice — `conventions` for `convention`, `contract-conformance` for `contract`. `review-gate.mjs` normalizes both to their canonical spelling *before* checking enum membership, on both the finding side and the `--block-on` side, so neither spelling fails closed and neither needs its own enum entry.

`convention` and `contract` joined `DEFAULT_BLOCK_ON` in #27, closing the gap #26 deliberately left open (a CONFIRMED finding in either used to merge silently). Widening the default this way would have promoted every cosmetic `convention` finding to a blocker on its own — `blocking` is what makes that safe: a reviewer marks the cosmetic ones `blocking: false` and only the finding that actually matters (a response-field description with its semantics backwards, say) blocks.

- `verdict: "blocking"` → at least one blocking finding, **or** at least one unrecognized category → route to `/review-loop`, then re-review; escalate to HITL if it can't clear within `--max-review-iter`.
- `verdict: "nits-only"` → mergeable; list the nits in the wave summary for the human.
- `verdict: "clean"` → mergeable.

Widen `--block-on` (e.g. add `efficiency`) to make a category **eligible** to block — outside `correctness`/`security` the reviewer's own `blocking: false` can still clear an eligible finding, and `selfClearedCount` says when it did. That is the axis's purpose rather than a hole in it (#27): widening the gate by hand to catch real defects in a category used to promote every cosmetic nit in that category too, which is what dispatched a fix pass over a documentary test case. An operator who wants a category to block unconditionally has `correctness` and `security`; every other category is narrowable by the reviewer, on the record.

The categories `--block-on` can name are the schema's `category` enum above, **plus the alternate spellings that normalize into it** — `--block-on conventions` is accepted and gates on `convention`, exactly as a finding spelled that way is scored as one. This is enforced, not aspirational, on both sides. A `--block-on` naming anything that does not normalize to an enum member is a usage error (`review-gate.mjs` exits 2 and echoes the enum), never a gate that silently matches no finding and merges anyway; and any *finding* whose category is outside the enum blocks regardless of `--block-on`. Both `--block-on <list>` and `--block-on=<list>` are accepted.
