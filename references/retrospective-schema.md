# Retrospective schema — cross-PR findings & plan adjustments

The step-6.5 Retrospective subagent returns this shape. It **reuses the vocabulary** of `references/review-schema.md` — `category` (`correctness | security | simplification | efficiency | test-coverage`) and confidence (`CONFIRMED | PLAUSIBLE`) — but is deliberately a **different envelope**: the review envelope is single-issue and merge-gated (`clean | blocking | nits-only`), while a retrospective is multi-PR, multi-location, and gates nothing — everything it examines has already merged. review-schema.md mirrors the built-in `/code-review` `ReportFindings` contract exactly and must not be extended, which is why this is a separate document rather than new fields there.

## Result envelope

```json
{
  "mergedPrs": ["owner/repo#41", "owner/repo#43", "other/repo#9"],
  "refactors": [ ... ],
  "planAdjustments": [ ... ],
  "observations": ["free-text pattern notes worth the human's eyes, not worth a ticket"]
}
```

`mergedPrs` echoes the input surface (composite **issue** refs, spanning repos where the run does), so the telemetry record built from this result is self-describing. There is **no `wave` field** — the main agent stamps its own wave counter on the telemetry record; the subagent has no wave concept. There is **no envelope verdict**: per-item confidence plus the human's point-D disposition (approve / decline) replace the `clean | blocking | nits-only` semantics, which only make sense before a merge.

## `refactors[]` — cross-PR findings that become tickets

```json
{
  "title":      "Extract shared exponential-backoff helper",
  "category":   "simplification",
  "confidence": "CONFIRMED",
  "summary":    "one-sentence statement of the duplication or divergence",
  "locations":  [{ "repo": "owner/repo", "file": "src/a/retry.ts", "line": 40 },
                 { "repo": "owner/repo", "file": "src/b/poll.ts",  "line": 112 }],
  "evidence":   ["owner/repo#41", "owner/repo#43"],
  "complexity": "normal",
  "suggestedEdges": [{ "blocked": "owner/repo#55", "blockedBy": "NEW" }],
  "body":       "draft ticket body to the /file-ticket bar: problem, desired end state, where (files/symbols), acceptance criteria, evidence PRs as context links"
}
```

- `category` / `confidence` — the review finding-item vocabulary, unchanged. `simplification` is the natural home for cross-PR duplication; a CONFIRMED `correctness`/`security` refactor (an interaction bug *between* two merged PRs) is legal and is surfaced first at point D.
- `locations[]` — **plural**, unlike a review finding's single `file`/`line`: a cross-PR finding is cross-cutting by nature. Each entry carries `repo` because the merged surface may span repos.
- `evidence[]` — **≥2 merged-PR issue refs**, the structural justification that this could not have been caught per-PR; a single-PR finding belongs to the review gate that already ran. At least one evidence ref must not itself be a retro-filed ticket's PR (the anti-recursion rule — no refactors of refactors).
- `complexity` — the triage enum (`mechanical | normal | complex`), carried into the filed ticket so triage/implement effort is assigned normally when it ships.
- `suggestedEdges[]` — `{blocked, blockedBy}` ref pairs, the literal string `"NEW"` standing for the ticket about to be filed. Approved edges are written **both** natively (the dependency graph) and as body prose (`Blocked by owner/repo#N`) so both of `plan-waves.mjs fetch`'s merged edge sources see them.
- `body` — the ghost-written draft `/file-ticket` publishes on approval.

## `planAdjustments[]` — keep the remaining DAG true

```json
{
  "ref":       "owner/repo#55",
  "kind":      "respec | add-edge | drop-edge | obsolete | split",
  "proposal":  "the concrete edit: replacement spec text, the edge endpoints, or the split children",
  "rationale": "why merged reality invalidates the current plan",
  "evidence":  ["owner/repo#43"],
  "edge":      { "blocked": "owner/repo#55", "blockedBy": "owner/repo#60" }
}
```

`edge` is present only for `add-edge`/`drop-edge`. `obsolete` closes the issue (`gh issue close --reason "not planned"`, with an explanatory comment) — the one destructive kind: point D confirms it **individually**, never inside a multiSelect batch. `split` files children (each to the refactors' `body` bar) and respecs the parent.

## The run ledger (main-agent state, not returned by the subagent)

The main agent carries, per run: `filed[]` (refs of approved-and-filed retro tickets) and `declined[]` (`{title, summary}` of rejected proposals). Both are injected into every later Retrospective prompt; a proposal naming substantially the same locations/title as a declined one must not reappear. This ledger — plus point D itself and the drain-time "ship now vs file for later" fork — is what keeps retro-filed tickets from turning the wave loop into an infinite one.

**Durability:** both halves are reconstructible from this run's `kind:"retro"` telemetry records (`filed[]`, `declinedTitles[]`) after a context compaction or resume. The record's `wave` number is a display label stamped by the main agent, not an index any logic depends on — a resumed run may restart it at a lower bound.
