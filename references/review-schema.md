# Review finding schema & the `--block-on` gate

The Opus review subagent returns findings in a **fixed schema** so the merge gate is defined in the tool's own vocabulary — never an invented High/Medium/Low severity (the built-in `/code-review`'s `ReportFindings` has no severity field, so thresholding on one is meaningless).

## Per-issue review result

```json
{
  "issue": 123,
  "findings": [
    {
      "category": "correctness | security | simplification | efficiency | test-coverage | convention | contract",
      "verdict":  "CONFIRMED | PLAUSIBLE",
      "file":     "path/to/file.ts",
      "line":     42,
      "summary":  "one-sentence statement of the defect",
      "failure_scenario": "concrete inputs/state → wrong output/crash"
    }
  ]
}
```

`verdict` mirrors the built-in `/code-review` `ReportFindings` contract exactly. `category` no longer does: `convention` and `contract` were added on top of the five `ReportFindings` categories, because logged review data showed reviewers emitting both — each under two spellings — with no fix available but widening the enum (see *The gate* below). The optional augmentation (unioning `/code-review` output into `findings[]`) still needs no translation, because the five `ReportFindings` categories are a subset of this enum and each is recognized as written. A `/code-review` finding whose category falls **outside** the seven gets no special case: it is normalized through the alias map, fails the membership test like any other unrecognized category, is named in `unknownCategories[]`, and blocks the merge. That is the specified behavior rather than an unreachable one — the gate does not assume what an external tool emits, so a `ReportFindings` contract that gains a category tomorrow costs one bounce, not a silent auto-merge.

## Where the object lives

The Review subagent **writes this object to a file** (`$STATE/reviews/<url-encoded-ref>.json`, path supplied by the main agent) and returns only `{ issue, path, findingCount, headline }`. Returning the findings inline instead parks every one of them in main-session context for the rest of the run — ~5k tokens for 13 findings on one PR in run sd-20260831-162148, when the gate needs only a verdict and a count. The findings are read back at the two moments they are actually used: routing a blocking PR to `/review-loop`, and showing a human what was found.

Because of that, the envelope no longer carries an overall `verdict` from the subagent. `scripts/review-gate.mjs` recomputes it from `findings[]`:

```
node scripts/review-gate.mjs <review.json> --block-on correctness,security
→ { issue, verdict, blockingCount, nitCount, findingCount, blocking[≤3], unknownCategories[], path }
```

A merge decision must not rest on a model's claim about its own output, and a review file with no `findings` array is a hard error rather than a silent `clean` — a truncated write must never auto-merge.

## The gate

`--block-on` is a comma-separated list of **categories** (default `correctness,security` — unchanged by the `convention`/`contract` widening; see below). Auto-merge is **blocked** for an issue when its review has **any finding whose `category ∈ --block-on` AND `verdict == CONFIRMED`** — **or any finding whose `category` is not one of the seven listed above, blank, or absent**. An unrecognized category is the same hazard as a missing `findings` array with a quieter failure mode: the gate cannot tell whether it names a correctness defect or a cosmetic nit, so it fails closed rather than defaulting to "nit". `unknownCategories[]` names every offending category (or `(blank)`) so an operator can act without opening the review file. Everything else (PLAUSIBLE findings in a known, non-blocking category) is surfaced but does **not** block.

Two of the seven have alternate spellings reviewers use in practice — `conventions` for `convention`, `contract-conformance` for `contract`. `review-gate.mjs` normalizes both to their canonical spelling *before* checking enum membership, on both the finding side and the `--block-on` side, so neither spelling fails closed and neither needs its own enum entry.

`convention` and `contract` are **not** in `DEFAULT_BLOCK_ON`: a CONFIRMED finding in either currently merges silently, same as any other known-but-not-blocked category. Deciding whether either belongs in the default gate is deferred to a follow-up ticket that owns blocking policy; until it lands, an operator who wants either to block widens `--block-on` per-run (e.g. `--block-on correctness,security,contract`).

- `verdict: "blocking"` → at least one blocking finding, **or** at least one unrecognized category → route to `/review-loop`, then re-review; escalate to HITL if it can't clear within `--max-review-iter`.
- `verdict: "nits-only"` → mergeable; list the nits in the wave summary for the human.
- `verdict: "clean"` → mergeable.

Widen `--block-on` (e.g. add `efficiency`) for a stricter gate; the categories it can name are exactly the schema's `category` enum above — this is enforced, not aspirational, on **both** sides. A `--block-on` naming anything else is a usage error (`review-gate.mjs` exits 2 and echoes the enum), never a gate that silently matches no finding and merges anyway; and any *finding* whose category is outside the enum blocks regardless of `--block-on`. Both `--block-on <list>` and `--block-on=<list>` are accepted.
