# Retrospective schema — cross-PR findings & plan adjustments

The step-6.5 Retrospective subagent returns this shape. It **reuses the vocabulary** of `references/review-schema.md` — `category` (`correctness | security | simplification | efficiency | test-coverage | convention | contract`) and confidence (`CONFIRMED | PLAUSIBLE`) — but is deliberately a **different envelope**: the review envelope is single-issue and merge-gated (`clean | blocking | nits-only`), while a retrospective is multi-PR, multi-location, and gates nothing — everything it examines has already merged. review-schema.md's `verdict` field mirrors the built-in `/code-review` `ReportFindings` contract exactly and must not be extended; `category` has already diverged from it (see review-schema.md), which is unrelated to why this is a separate document rather than new fields there.

## Result envelope

```json
{
  "mergedPrs": ["owner/repo#41", "owner/repo#43", "other/repo#9"],
  "refactors": [ ... ],
  "planAdjustments": [ ... ],
  "observations": ["free-text pattern notes worth the human's eyes, not worth a ticket"]
}
```

The subagent **writes this envelope to a file** (`$STATE/retro/wave-<W>.json`) and returns it **minus every `refactors[].body` and `planAdjustments[].proposal`** — the two long fields. Point D's grilling renders from titles, summaries, evidence and edges; the drafted text is needed only for the proposals the human approves, which is the minority, and is fetched back one at a time with `scripts/retro-pick.mjs <file> <id>`. Every proposal therefore carries a stable `id` — `R1, R2, …` for refactors, `P1, P2, …` for plan adjustments, in ranked order — which is what the picker keys on.

`mergedPrs` echoes the input surface as bare composite **issue** refs (spanning repos where the run does). The PR numbers ride in the prompt, not the envelope — the main agent hands the subagent `owner/repo#N (PR #M)` pairs so `gh pr diff` is runnable; to recover which PR a ref shipped under from telemetry alone, join against the run's `kind:"issue"` records' `pr` field. There is **no `wave` field** — the main agent stamps its own wave counter on the telemetry record; the subagent has no wave concept. There is **no envelope verdict**: per-item confidence plus the human's point-D disposition (approve / decline) replace the `clean | blocking | nits-only` semantics, which only make sense before a merge.

## Filing rules

What a retrospective may file. The Retrospective subagent proposes only within them, and point D declines (recording it under `observations`) any proposal that breaks rule 2, 3 or 4. Decided 2026-11-14 (`references/decisions.md`, D11), from an analysis of 65 retro-filed tickets: defect fixes, helpers already duplicated and the local gate script paid back; test-only tickets that pin one feature's internals cost more than they returned; a third of the tickets were never scheduled.

1. **A real defect fix is always eligible.** A CONFIRMED `correctness` or `security` finding, including an interaction bug between two merged PRs.
2. **A shared helper or refactor needs two or more copies already in merged code.** This tightens the `evidence[]` rule below: the copies must exist and be cited, not be anticipated by a pending leaf.
3. **Never file a test-only ticket that pins one feature's internals.** Fold the coverage into the feature's next PR as a `respec` plan adjustment (a comment) on that pending leaf.
4. **At most two filed tickets per retrospective.** Only a defect fix may block a pending leaf (sit on its critical path); any other ticket's `suggestedEdges` must not name a pending leaf as `blocked`. Plan adjustments that are comments or edge edits (`respec`, `add-edge`, `drop-edge`, `obsolete`) are uncapped, since they file nothing; a `split` files children, and those count toward the two.
5. **A retro-filed ticket open more than 7 days is scheduled or closed.** At every wave's step 6.5, including a wave whose pass skips below `--retro-threshold`, list each ref in the run ledger's `filed[]` and in the `filed[]` of the run's earlier `kind:"retro"` records, and read its `state` and `createdAt` (`gh issue view <N> --repo owner/repo --json state,createdAt`). One still open after 7 days is either scheduled into a wave (it joins the DAG for the next step 1, with its leaf's edges kept) or closed with `gh issue close <N> --repo owner/repo --reason "not planned"`; either way, ghost-write a comment saying which and why. Closing is the destructive act, so confirm it individually, as for `obsolete`.
6. **Never schedule a refactor and a feature in the same files at the same time.** When a proposed refactor's `locations[]` are files a pending leaf edits, the refactor waits until that leaf merges (it is filed then, or filed with the leaf as its `blockedBy`), unless its `summary` says why it must go first.

## `refactors[]` — cross-PR findings that become tickets

```json
{
  "id":         "R1",
  "title":      "Extract shared exponential-backoff helper",
  "repo":       "owner/repo",
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

- `repo` — the repo the ticket is filed in. Required whenever the run spans repos: `locations[]` alone doesn't determine it, and `/file-ticket` defaults to the current repo — which may contain none of the code the refactor describes. In a single-repo run it defaults to the run's repo.
- `category` / `confidence` — the review finding-item vocabulary, unchanged. `simplification` is the natural home for cross-PR duplication; a CONFIRMED `correctness`/`security` refactor (an interaction bug *between* two merged PRs) is legal and is surfaced first at point D.
- `locations[]` — **plural**, unlike a review finding's single `file`/`line`: a cross-PR finding is cross-cutting by nature. Each entry carries `repo` because the merged surface may span repos.
- `evidence[]` — **≥2 merged-PR issue refs** (the copies rule 2 requires, already merged), the structural justification that this could not have been caught per-PR; a single-PR finding belongs to the review gate that already ran. At least one evidence ref must not itself be a retro-filed ticket's PR (the anti-recursion rule — no refactors of refactors).
- `complexity` — the triage enum (`mechanical | normal | complex`), carried into the filed ticket so triage/implement effort is assigned normally when it ships.
- `suggestedEdges[]` — per rule 4, a pair that makes a pending leaf `blocked` by `NEW` is allowed only for a defect fix (`correctness`/`security`, CONFIRMED); every other refactor's list holds no such pair. `{blocked, blockedBy}` ref pairs, the literal string `"NEW"` standing for the ticket about to be filed. Approved edges are written **both** natively (the dependency graph) and as body prose (`Blocked by owner/repo#N`) so both of `plan-waves.mjs fetch`'s merged edge sources see them. `blockedBy` may name an already-**merged** issue in a *different* repo when the refactor consumes its artifact — such an edge never blocks (fetch folds it into `done[]`); it exists to route the ticket through step 7's point-C cutover gate instead of letting it auto-release against an unpublished artifact.
- `body` — the ghost-written draft `/file-ticket` publishes on approval. **Omitted from the subagent's return**; it lives in the result file and is fetched by `id` once the human approves the proposal.
- `id` — `R1, R2, …` in ranked order. The handle point D uses to fetch this proposal's `body` back without re-reading the rest.

## `planAdjustments[]` — keep the remaining DAG true

```json
{
  "id":        "P1",
  "ref":       "owner/repo#55",
  "kind":      "respec | add-edge | drop-edge | obsolete | split",
  "proposal":  "the concrete edit: replacement spec text, the edge endpoints, or the split children",
  "rationale": "why merged reality invalidates the current plan",
  "evidence":  ["owner/repo#43"],
  "edge":      { "blocked": "owner/repo#55", "blockedBy": "owner/repo#60" }
}
```

`id` is `P1, P2, …`, the handle `retro-pick.mjs` keys on; `proposal` is **omitted from the subagent's return** for the same reason `body` is, and fetched back by id on approval. `edge` is present only for `add-edge`/`drop-edge`. `obsolete` closes the issue (`gh issue close --reason "not planned"`, with an explanatory comment) — the one destructive kind: point D confirms it **individually**, never inside a multiSelect batch. `split` files children (each to the refactors' `body` bar) and respecs the parent.

## The run ledger (main-agent state, not returned by the subagent)

The main agent carries, per run: `filed[]` (refs of approved-and-filed retro tickets) and `declined[]` (`{title, summary}` of rejected proposals). Both are injected into every later Retrospective prompt; a proposal naming substantially the same locations/title as a declined one must not reappear. This ledger — plus point D itself and the drain-time "ship now vs file for later" fork — is what keeps retro-filed tickets from turning the wave loop into an infinite one.

**Durability:** the ledger survives a context compaction or resume via this run's `kind:"retro"` telemetry records — `filed[]` fully; the declined half as `declinedTitles[]`, **titles only** (the summary/locations signal is lost, so after a resume the no-re-propose rule matches on titles and point D backstops any near-duplicate that slips past the match). The record's `wave` number is a display label stamped by the main agent, not an index any logic depends on — a resumed run may restart it at a lower bound.
