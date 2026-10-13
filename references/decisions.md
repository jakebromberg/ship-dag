# Tuning decision log

One entry per decision in #64 (D1–D8), then the cross-cutting tripwire that guards no single decision, then the metric definitions the tripwires are computed under, then the dismissals. SKILL.md step 7 runs `telemetry.mjs tripwires` and answers a tripped tripwire here. Every decision was taken on 2026-10-08 ("go with recommendations", #64), so each first review date is 2026-12-07, 60 days later.

Each entry's *Review date* is also the `reviewDate` of every row in `references/tripwires.json` whose `decision` names that entry: `D1`–`D8` name a decision, and `all` names the entry of the row's own id under *Cross-cutting tripwires*. `tripwires` reports `reviewOverdue` once that date has passed. Change the two together; `scripts/lib/tripwires.test.mjs` fails when they disagree. When a review is answered, move the date to the answer date + 60 days in both places, or every later wave reports it overdue again.

## Decisions

### D1: the review effort floor stays `high` for both passes

- **Choice:** #11 proposed `medium` for the verify pass and for in-diff explore. Both passes stay at `high`.
- **Decided:** 2026-10-08.
- **Tripwire:** T-floor, from the eval, verify pass only: trips when `verify-medium`'s recall is within 5 points of `verify-high`'s and its cost is at most 70% of high's. It is not in `tripwires.json` yet; #171 adds the row and its evaluator, reading a saved scorecard. The explore floor is not eval-tunable; T-explore-unique governs it.
- **PR:** none. The decision keeps today's setting. U4 (#76) adds the `verify-high` and `verify-medium` eval variants.
- **Review date:** 2026-12-07.

### D2: two Opus passes per PR

- **Choice:** verify and explore, including the step 6 item 2 post-rebase re-gate.
- **Decided:** 2026-10-08.
- **Tripwires:** T-explore-unique and T-escapes (rows in `tripwires.json`), and T-review-latency and T-review-cost (not in it yet; #170 adds them).
- **PR:** the two-pass review lands with the W slices (W2a #79, W2b #80, switched on by W4 #83). None has landed yet.
- **Review date:** 2026-12-07. A tier that has not reached 73 PRs by then gets a decision on the evidence there is.

### D3: scoped re-gate only after a `/review-loop` fix

- **Choice:** step 6 item 2 stays a full review.
- **Decided:** 2026-10-08.
- **Tripwire:** T-scoped.
- **PR:** W4 (#83), not yet landed.
- **Review date:** 2026-12-07. If scoped-then-full pairs have not reached 10, the date forces a decision.

### D4: triage emits `reach` and `decisions`

- **Choice:** the main agent no longer sets them.
- **Decided:** 2026-10-08.
- **Tripwire:** T-reach.
- **PR:** #90 (W3, #81), which also carries them through the ready-wave spec.
- **Review date:** 2026-12-07.

### D5: the `workflow.js` fallback stays single-pass

- **Choice:** only the engine path gets two passes.
- **Decided:** 2026-10-08.
- **Tripwire:** T-fallback.
- **PR:** none. `workflow.js` is unchanged.
- **Review date:** 2026-12-07.

### D6: #17 lands, reworked and split

- **Choice:** wave telemetry is derived from the engine's own artifacts, not remembered.
- **Decided:** 2026-10-08.
- **Tripwire:** T-coverage.
- **PR:** #86 (T1 #67, the append-only wave sidecar that `ingest-wave` and `audit` read), #98, #102, #103, #104, #105, #146 and #159, with the tripwire itself in #163.
- **Review date:** 2026-12-07.

### D7: retry dirs `-b` and `-c` fold into their base run

- **Choice:** `sameRun` folds `-w…`, `-r…`, `-wave…`, `-resume`, `-b`, `-c`, the `ship-dag-` prefix and case.
- **Decided:** 2026-10-08.
- **Tripwire:** the deterministic family check from R1: every engine dir's family agrees with its config `name`. It is not a row in `tripwires.json`, and it is not a test: the unit suite no longer reads the real state dir. PR #85 ran it once by hand on 2026-10-08 (81 of 81 dirs, 0 mismatches). Nothing has re-run it since, so re-run it by hand at the review date.
- **PR:** #85.
- **Review date:** 2026-12-07.

### D8: close #11 and #17

- **Choice:** both are closed with comments linking the replacement issues. Either can be reopened.
- **Decided:** 2026-10-08.
- **Tripwire:** none. The decision is reversible.
- **PR:** none. #11 and #17 are closed.
- **Review date:** 2026-12-07.

## Cross-cutting tripwires

A tripwire whose `decision` in `tripwires.json` is `all` guards every decision at once, so it has its own entry and review date here.

### T-cost: implement cost per version

- **Guards:** every decision. Per tier, it compares the mean exact implement cost of a tuning version's first 30 merged PRs with the previous version's. It trips when the lower bound of the current mean's bootstrap interval is above 1.5 times the previous mean, and the result is surfaced for review. It never reverts anything by itself.
- **Decided:** 2026-10-08, in #64's tripwire table, with D1–D8.
- **PR:** #163, with the tripwire table.
- **Review date:** 2026-12-07.

## Metric definitions

Each definition lists what is counted, when it was settled, and the PR that implements it. **Changing a definition requires recomputing the tripwire's baseline.** A T-escapes or T-coverage tripwire that trips because the definition changed is answered with **retune**: recompute the baseline, never dismiss it.

### T-escapes

- **Definition:** closed-unmerged PR candidates are dropped. Open or merged PRs, and bug issues (open or closed), count. The headline rate counts any citation, with the `strong`/`strongRate` sub-rate beside it. Only the merged PR's own repo is searched. A candidate's state is frozen when its day settles.
- **Settled:** 2026-10-12, at point A for #74.
- **Implemented:** PR #153 (issue #152).
- **Baseline:** every closed-window ship-dag merge before W4 (tuning version 2), computed under this definition.

### T-coverage

- **Definition:** the share of terminal report rows that `rowCovered` (which is `sameEvent`) covers, per run family, counted only for families after T6 (#73). It reads `audit`'s `terminalRows` and `prRows`. The `cost.implement` presence share is counted inside the same window, per record.
- **Counting rules:** a row that a retry carries over counts once for each report that lists it. A run with no engine dir (`audit` finds no dir under the base dir for it) is skipped and counted under `skipped`, neither tripped nor holding.
- **Settled:** 2026-10-12 (2:15 PM PDT), the wave-10 respec of #74.
- **Implemented:** PR #163. Its window is per family, from `since` = `2026-10-12T23:52:28Z` (4:52 PM PDT on 2026-10-12), when PR #159 merged. A family with any current-version record at or after `since` is audited whole, its earlier rows included.
- **Note:** run sd-20261008-153059 spans `since`, so its pre-T6 rows are in the first readings.
- **Changed:** 2026-10-12, issue #160 (the PR that closes it). `rowCovered` reads a report row's `ran` fact: a row that launched no session is covered by an earlier report's record only when an earlier report of the run family lists the same ref with the same status and PR (a PR-less failure never is, since a retry re-runs it); any other row is the report's own event and needs a record carrying its `reportId`. A row with no `ran` (a pre-change report) is covered as before. The coverage share can fall for families whose reports carry `ran`: a merge re-run in a later report, or a pre-launch failure, is no longer covered by an earlier report's record. **Baseline:** none recorded yet (`at T4 landing`), so there is nothing to recompute; the first baseline is taken under this definition.

## Dismissals

A tripped tripwire that the human dismisses is logged here, so the same evidence is not proposed again. One entry each: the tripwire id, the date, the evidence that tripped it (sample and rate), and the reason. None yet.
