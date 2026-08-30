# Review finding schema & the `--block-on` gate

The Opus review subagent returns findings in a **fixed schema** so the merge gate is defined in the tool's own vocabulary — never an invented High/Medium/Low severity (the built-in `/code-review`'s `ReportFindings` has no severity field, so thresholding on one is meaningless).

## Two passes, one verdict

On the primary path (`review-workflow.js`, SKILL.md step 4d) each PR gets **two** Opus passes at different efforts — **Verify** (confirm the enumerated decisions landed; confirm each new test can fail) and **Explore** (find what nobody asked, deliberately without the checklist). Each returns `{ findings[], notes }` in the item schema below; the workflow concatenates them, dedupes on `file` + `line` + normalized `summary` — keeping the **CONFIRMED** copy when the two disagree, since a traced finding outranks a suspected one — and computes **one** verdict by the gate below. Consumers see the same per-issue shape they always did.

### `incomplete`

The merged row also carries `incomplete: true` when **either pass failed to return**. This is not a severity — it is a statement that the gate did not fully run, and step 5 **must not** auto-merge such a row whatever its `verdict` says. A `clean` computed from one surviving pass is indistinguishable in shape from a real `clean` and means nothing, so the flag is the only thing standing between a crashed reviewer and an unreviewed merge. Re-run the gate for that PR; on a second failure, escalate to HITL point B.

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
