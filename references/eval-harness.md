# Eval harness — measuring ship-dag model-assignment efficacy

The offline counterfactual study: replay a frozen corpus of real merged WXYC issues through model-assignment **variants** in a sandbox, and score cost vs quality, to decide whether Haiku-triage / Sonnet-implement / Opus-review sits on the cost/quality frontier. This is the expensive companion to the always-on telemetry (see the *Telemetry* section of `SKILL.md`) — run it when a telemetry trip-wire fires.

**Status:** complete. PR 2a shipped the corpus + configuration; PR 2b shipped the engine — the sandboxed replay driver, the three quality tracks, cost attribution, and the offline scorer.

## How a study runs

Running a study spawns real implement/review agents against real repos, so it is **cost-gated and user-invoked** — never triggered automatically.

**Phase 0 — build the frozen mutant bank (compute only, ~$0 agent tokens):**

0a. **Host preflight**: `node eval/preflight-host.mjs` verifies `gh` auth + per-language toolchains and prints a per-repo gatable/parse-only verdict (detect-then-decide: a missing toolchain demotes a repo to parse-only; a present `xcodebuild` promotes Swift to gatable).
0b. **Bank build**: `node eval/build-mutant-bank.mjs` clones each corpus entry at `mergeSha`, requires a GREEN baseline suite, enumerates all five mutation kinds across the PR's source files, applies the **test-failure gate**, and freezes surviving mutants — each with a re-apply descriptor and a rendered diff — into `eval/mutant-bank.json`. Deterministic, agent-free; run once and reuse across every variant.

**Replay + score (per variant):**

1. **Probe** (free, zero agents): `Workflow({ scriptPath: '<abs>/eval/probe.js' })` confirms the Workflow runtime exposes `budget`/`log`. If `hasBudget` is false, the quality tracks still run but every stage records `tokens:null` and the cost track is unavailable.
2. **Replay** (costly): `Workflow({ scriptPath: '<abs>/eval/harness.js', args: { runId, variant, spec, entries, bank } })` where `spec` is a variant's per-stage `{model,effort}` (from `variants.mjs`), `entries` is a `corpus.json` subset, and `bank` is `mutant-bank.json`'s `.mutants`. It runs triage → implement → yield → recall per issue and returns **raw** per-issue data — triage labels, file sets, self-labels, per-mutant caught flags, per-stage token deltas — computing nothing. Run one variant per invocation; every variant judges the identical frozen bank, so recall is **paired**. The harness applies one implement effort to every tier (`spec.implement.effort`), so it does not model the per-tier implement map in `tuning.json`; `variants.current` is pinned to the `normal` entry.
3. **Score** (free): pipe the harness's raw JSON to `node eval/score.mjs -` (or `@raw.json`). This computes the scorecard and persists it to `~/.local/state/ship-dag/eval-results/<runId>.json`, **never overwriting** a prior run. Score every variant, then compare scorecards on the cost/quality frontier.

Keeping all math in step 3 (and the gate decision in `lib/gate.mjs`) means the un-runnable driver stays thin and everything that decides a number is a pure, unit-tested module.

## Corpus (`eval/corpus.json`)

A frozen, committed manifest of issues that were actually shipped — each merged PR is its issue's known-good reference. Built by:

```
node eval/corpus.mjs build --repos WXYC/a,WXYC/b [--per-tier N] [--limit M] > eval/corpus.json
```

- **Deterministic selection** (most-recent-first per tier) so re-running reproduces the same manifest *given unchanged repo history*; the window is "the last `limit` merged PRs", so the committed file — not a rebuild — is canonical. The file is intentionally timestamp-free to stay diff-stable.
- **Stratified** by complexity tier (`eval/lib/tier.mjs`): `mechanical` (≤1 file and ≤10 adds), `complex` (≥5 files, ≥200 adds, or a migration/schema/security path or label), else `normal`. Corpus tiering is size-based — the PR list exposes counts, not file paths.
- Each entry: `{ repo, defaultBranch, issue, pr, mergeSha, baseSha, tier, changedFiles, additions, title }`. `baseSha` is the parent of the PR's first commit — the state the implementer started from (correct for both merge and rebase strategies).
- The shipped corpus spans 5 repos / 5 languages (Python, TypeScript, PLpgSQL, Rust, Swift). Swift/PLpgSQL entries can't run local CI (no Xcode/DB on the eval host), so for those the harness leans on the review-side quality tracks.

## Variants (`eval/variants.mjs`)

Model-assignment vectors, each `{ model, effort }` per stage:

| Variant | triage | implement | review |
|---|---|---|---|
| `current` | haiku/low | sonnet/medium | opus/high |
| `ceiling` | opus/high | opus/high | opus/high |
| `floor` | haiku/low | sonnet/low | sonnet/high |
| `opus-triage` | opus/high | sonnet/medium | opus/high |
| `sonnet-review` | haiku/low | sonnet/medium | sonnet/high |

`ceiling`/`floor` bracket `current`; the single-stage swaps isolate one lever so a quality/cost delta pins to a specific stage. `floor` keeps the already-cheapest Haiku triage and instead downgrades the expensive review stage.

## Quality tracks (`eval/lib/score.mjs`)

Each variant's raw replay is scored on four quality dimensions plus cost. `buildScorecard(raw)` ties them together and attaches `warnings` for anything a reader must not miss (lower-bound cost, placeholder prices, empty recall track, a thin test-gated bucket, an empty triage track).

- **Triage quality** (`scoreTriage`): does the triage model, reading ONLY the issue text, predict the complexity the work turned out to be? The corpus `tier` is the ground-truth label (the decision-relevant one — complexity routes implement *effort* per `model-effort-matrix.md`). Reports exact + adjacent (off-by-one on the ordered scale) accuracy and a confusion matrix, plus the routing (clear/needs-decision) distribution as a secondary signal (no gold routing label in the corpus; cross-model κ lives in the report step). Triage is scored **open-loop** — it does not re-route the implement stage.

- **Implement correctness** (`scoreImplement` + `eval/lib/jaccard.mjs`): the file set the variant *touched* vs the file set the gold merge touched — Jaccard as the headline, with precision (over-editing) and recall (under-editing) to attribute a low score, reported overall and by tier. File-set overlap is a coarse proxy (it doesn't judge *what* changed inside a file); an anchored-judge content score can layer on later, but the file-set signal already separates "edited the right area" from "wandered".
- **First-pass yield** (`scoreFirstPass`): the self-labeled rate at which the implementation would merge without a review bounce. Self-labeled by the review model, so it is a *relative* signal across variants, not an absolute truth — read it alongside the anchored recall track below.
- **Review recall** (`scoreReview` + `eval/mutate.mjs` + `eval/lib/gate.mjs`): mutation testing against the **frozen, test-gated bank**. A small behavior-changing defect is seeded into a gold file once (offline, in `build-mutant-bank.mjs`), gated on **test failure** — a mutant that fails no test is equivalent/uncovered and dropped — and every variant's **fresh, blind** reviewer judges the byte-identical diff. The seeded mutation is the ground-truth label, sidestepping the circularity of a model reviewing itself; test-gating removes the equivalent-mutant noise the pilot flagged; the shared bank makes recall **paired** across variants. Mutators are token-level and language-agnostic (relational/equality/boolean/await/off-by-one) so one implementation seeds Python, TS, Rust, Swift, and SQL alike. Recall is reported overall, **by bucket** (headline = test-gated; parse-only kept separate for Swift/SQL without a host suite), by kind, and by tier.

## Prices & cost (`eval/prices.mjs`, `scoreCost`)

`OUTPUT_USD_PER_MTOK` — **placeholder** output-token rates (USD per 1M output tokens). Output dominates model cost and is the only figure the Workflow `budget.spent()` delta exposes, so the harness attributes cost as output-tokens × these rates. **Update to current published prices before trusting any `$` figure** (the scorecard warns until you pass real prices).

`budget.spent()` is a single shared cumulative counter, so the harness runs **serially** (`for…await`) and reads it around each awaited agent; the delta is that stage's output tokens. A null delta (budget unavailable) is skipped and flips `tokensMissing`, making the total an explicit **lower bound** rather than a silent zero. Caveat: if the main loop spends concurrently while a study runs, deltas over-count — treat cost as indicative and re-confirm on a quiet session. The headline is `perMergedUSD` (total ÷ self-labeled merged count), the unit that matters for a coupled pipeline.

## Comparing variants (`eval/report.mjs`)

Once two or more variants have been replayed and their **raw** harness JSONs saved, pair them:

```
node eval/report.mjs current.raw.json sonnet-review.raw.json [ceiling.raw.json ...]
```

The first file is the reference. Because every variant judged the identical frozen bank and the same issues, the comparison is paired:

- **Review recall** — exact **McNemar** over the common test-gated mutants (`mcnemar` in `scripts/lib/stats.mjs`): how many gated mutants the reference caught that the comparator missed, and vice-versa, with a two-sided exact binomial p-value (valid at small n).
- **Implement** — a **bootstrap CI** of the per-issue paired Jaccard difference (`bootstrapCI`, seeded so it's reproducible).
- **Cost** — per-stage $ and $/merged side by side.

`report.mjs` only pairs, calls the tested pure functions, and formats — it holds no inline statistics, so every number it prints comes from a unit-tested module.

## Safety & sandboxing

Every harness agent works in a **disposable clone** and is told, redundantly, to **NEVER push, open a PR, or write to any real remote** — a study is an offline replay of already-merged history and must leave no outward trace. Scorecards persist outside the `~/.claude` repo (XDG state dir), and `writeResults` refuses to overwrite an existing `runId`, so a completed study is never silently clobbered.

## Known gaps

- **Gold = the PR's own files, not a commit range.** `goldFiles` is `gh pr view <pr> --json files`, not `git diff baseSha..mergeSha` — the range sweeps in unrelated commits that merged while the PR was open (a 1-file PR showed 11). Harness `entries` therefore need the corpus `pr` field.
- **First-pass yield is self-labeled.** The review model grades whether its own stage would merge the implementation, so yield is a *relative* signal across variants, not absolute truth — read it alongside the anchored, test-gated recall track.
- **The blind reviewer sees a small hunk, not the whole PR.** Recall judges a rendered 1-line diff (with a few lines of context), which is easier than a full review — so absolute recall is likely optimistic. The bias is equal across variants (they judge the identical bank), so *differences* between variants survive it.
- **Parse-only mutants are noisier than gated ones.** Where the host can't run a suite (PLpgSQL without a DB, and Swift when `xcodebuild`/a simulator is absent), mutants fall to the parse-only bucket — kept, but reported separately so they never dilute the headline test-gated recall.

*Closed by PRs A/B (Phase 0 of the full study):* the **test-failure mutation-validity gate** (equivalent/uncovered mutants are now dropped, not counted as misses) and the **triage stage + triage-quality scoring** (the triage lever is now measured, open-loop, against the realized tier).

## Files

```
eval/
  corpus.json          frozen manifest of real merged issues (canonical)
  corpus.mjs           corpus builder (CLI + pure parse/stratify)      [2a]
  variants.mjs         model-assignment vectors                        [2a]
  prices.mjs           output-token price table + costUSD              [2a]
  mutate.mjs           mutation generators (library + CLI)             [2b]
  repo-tests.mjs       per-repo test-suite config for the gate         [A]
  preflight-host.mjs   host preflight (gh-auth + toolchains)           [A]
  build-mutant-bank.mjs deterministic gated mutant-bank builder        [A]
  mutant-bank.json     frozen, test-gated mutants (built once)         [A]
  probe.js             zero-agent Workflow probe (budget/log check)    [2b]
  harness.js           Workflow replay driver (triage→impl→yield→recall)[2b/A/B]
  score.mjs            offline scorer CLI (raw → scorecard → persist)  [2b]
  lib/
    tier.mjs           complexity tiering                              [2a]
    jaccard.mjs        file-set overlap metrics                        [2b]
    gate.mjs           mutation-validity (test-failure) classifier     [A]
    score.mjs          scorecard aggregation (+ triage, by-tier)       [2b/B]
    results.mjs        scorecard persistence (never overwrite)         [2b]
```

## Tests

`node --test "skills/ship-dag/eval/**/*.test.mjs"` — pure helpers only (tiering, prices, variants, corpus builder, jaccard, mutate, score, results). The Workflow drivers (`harness.js`, `probe.js`) use the runtime's `export`+top-level-`return` form and are validated by running a study, not by `node --test`.
