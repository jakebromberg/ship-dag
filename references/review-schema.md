# Review finding schema & the `--block-on` gate

The Opus review subagent returns findings in a **fixed schema** so the merge gate is defined in the tool's own vocabulary — never an invented High/Medium/Low severity (the built-in `/code-review`'s `ReportFindings` has no severity field, so thresholding on one is meaningless).

## Per-issue review result

```json
{
  "issue": 123,
  "findings": [
    {
      "category": "correctness | security | simplification | efficiency | test-coverage",
      "verdict":  "CONFIRMED | PLAUSIBLE",
      "file":     "path/to/file.ts",
      "line":     42,
      "summary":  "one-sentence statement of the defect",
      "failure_scenario": "concrete inputs/state → wrong output/crash"
    }
  ]
}
```

`category` and `verdict` mirror the built-in `/code-review` `ReportFindings` contract exactly, so the optional augmentation (unioning `/code-review` output into `findings[]`) needs no translation.

## Where the object lives

The Review subagent **writes this object to a file** (`$STATE/reviews/<url-encoded-ref>.json`, path supplied by the main agent) and returns only `{ issue, path, findingCount, headline }`. Returning the findings inline instead parks every one of them in main-session context for the rest of the run — ~5k tokens for 13 findings on one PR in run sd-20260831-162148, when the gate needs only a verdict and a count. The findings are read back at the two moments they are actually used: routing a blocking PR to `/review-loop`, and showing a human what was found.

Because of that, the envelope no longer carries an overall `verdict` from the subagent. `scripts/review-gate.mjs` recomputes it from `findings[]`:

```
node scripts/review-gate.mjs <review.json> --block-on correctness,security
→ { issue, verdict, blockingCount, nitCount, findingCount, blocking[≤3], unknownCategories[], path }
```

A merge decision must not rest on a model's claim about its own output, and a review file with no `findings` array is a hard error rather than a silent `clean` — a truncated write must never auto-merge.

## The gate

`--block-on` is a comma-separated list of **categories** (default `correctness,security`). Auto-merge is **blocked** for an issue when its review has **any finding whose `category ∈ --block-on` AND `verdict == CONFIRMED`**. Everything else (PLAUSIBLE findings, non-blocking categories, cosmetic nits) is surfaced but does **not** block.

- `verdict: "blocking"` → at least one blocking finding → route to `/review-loop`, then re-review; escalate to HITL if it can't clear within `--max-review-iter`.
- `verdict: "nits-only"` → mergeable; list the nits in the wave summary for the human.
- `verdict: "clean"` → mergeable.

Widen `--block-on` (e.g. add `efficiency`) for a stricter gate; the categories are exactly the schema's `category` enum.
