# Review finding schema & the `--block-on` gate

The Opus review subagent returns findings in a **fixed schema** so the merge gate is defined in the tool's own vocabulary — never an invented High/Medium/Low severity (the built-in `/code-review`'s `ReportFindings` has no severity field, so thresholding on one is meaningless).

## Per-issue review result

```json
{
  "issue": 123,
  "verdict": "clean | blocking | nits-only",
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

## The gate

`--block-on` is a comma-separated list of **categories** (default `correctness,security`). Auto-merge is **blocked** for an issue when its review has **any finding whose `category ∈ --block-on` AND `verdict == CONFIRMED`**. Everything else (PLAUSIBLE findings, non-blocking categories, cosmetic nits) is surfaced but does **not** block.

- `verdict: "blocking"` → at least one blocking finding → route to `/review-loop`, then re-review; escalate to HITL if it can't clear within `--max-review-iter`.
- `verdict: "nits-only"` → mergeable; list the nits in the wave summary for the human.
- `verdict: "clean"` → mergeable.

Widen `--block-on` (e.g. add `efficiency`) for a stricter gate; the categories are exactly the schema's `category` enum.
