# Escalation policy — when to grill the human

`/ship-dag` runs autonomously *except* at five human-in-the-loop points — A (triage), B (implement/review), C (cross-repo cutover), D (retrospective), E (rate-limit window). A and B fire when the design premise breaks — a well-specced issue Sonnet-implements and survives the Opus gate cleanly; **when that premise breaks, that break is the escalation signal.** C and D are **scheduled gates** built into the loop. E is neither: it fires when the account's five-hour rate-limit window can't be waited out cheaply (step 4's preflight, and the identical fork mid-recovery-recipe below) — an infra constraint, not a premise break, and deliberately kept distinct from B (see the *Point E* section — a rate-limit death is not a model failure).

## Triggers (any one → pause and grill)

1. **Underspecced issue** — triage (or the implement subagent) cannot resolve an ambiguity from the issue body + repo conventions. A guess would be a coin flip on intent.
2. **Architectural fork or new dependency** — the work forces a design choice with lasting consequences, or pulls in a new third-party dependency.
3. **Unclearable blocking finding** — the Opus gate blocks the PR (a finding whose `category ∈ --block-on` **and** `verdict == CONFIRMED` **and** whose `blocking` is not explicitly `false`, or one whose category is outside the enum at all) and `/review-loop` cannot clear it within `--max-review-iter`, or it needs a design decision rather than a mechanical fix.
4. **Unreadable review, twice** — `review-gate.mjs` exits 3 (unparseable review file, no `findings` array, or a finding count disagreeing with what the Review subagent reported writing) and a re-run of the reviewer exits 3 again. One exit 3 is a re-run; two is a signal that something is wrong with the reviewer or the state dir rather than with the PR. Never fall back to merging on CI alone, and never repair the file by hand — a review nobody can read is not a review.
5. **Non-flaky CI failure** — CI fails for a real reason (not a known-flaky/infra retry). Per global rules, ≤2 manual retries on infra failure, then stop — never loop.
6. **Merge conflict needing judgment** — a rebase conflict whose resolution isn't mechanical.
7. **Oversize issue** (point A) — triage estimates the issue needs more than 200 added lines of production source. The fork is split-now vs accept-the-size, and it is a scope call the human owns. It costs minutes here and a whole branch later, so it is worth a grill even though nothing is ambiguous.
7. **Rate-limit window can't be waited out cheaply** (point E) — the step-4 preflight (`scripts/rate-limit-preflight.mjs`), or the identical fork hit mid-recovery-recipe while waiting out a live rate-limit death, finds the five-hour window at/above threshold with the reset more than `--wait-max-minutes` away, or no reset time at all: wait / defer this wave (or issue) / stop the run.

## Protocol

`grill-me` is inherently interactive and one-question-at-a-time, and the orchestrator is *already* the interactive agent — so conduct the interview **inline** rather than spawning `grill-me` (which would hijack the turn). Steps:

1. **Batch, don't drip.** At the triage gate (HITL point A) and the retrospective gate (point D), collect *all* underspecced questions and proposals across the wave and grill once, not per-item.
2. **Give full context** — the issue, the relevant diff/finding, and why the autonomous path stopped. Use `AskUserQuestion` for crisp forks (2–4 options, recommended first); use an inline grill-me-style interview for open-ended design questions.
3. **Persist the resolution** as a GitHub issue comment (ghost-writer: no Claude/AI attribution), and update the issue body if scope changed — so peers and future waves inherit the decision.
4. **Resume the wave** with the decision applied. Only genuinely cleared issues proceed to implementation.

Suggest the user run `/grill-me` themselves if they want the full adversarial treatment on a thorny fork.

## Point D — the retrospective gate (scheduled, not premise-break)

Fires from step 6.5 when unretrospected merges reach `--retro-threshold` (and always once at drain). The letters are stable IDs, not loop order — within a wave, D (step 6.5) fires *before* C (step 7). The Retrospective subagent only proposes; every disposition is the human's:

- **Batch into one grilling.** Refactor proposals via `AskUserQuestion` `multiSelect` (title + summary + evidence PRs per option, ≤4 per question); plan adjustments likewise; open-ended respecs get the inline interview. `obsolete` closures are confirmed individually — never inside a multiSelect batch.
- **Approved** → ghost-written side effects only: `/file-ticket` tickets (inserted per the run's issue-set form), issue comments/body edits recording the decision and reasoning, native + prose dependency edges. No Claude/AI attribution anywhere, as always.
- **Declined** → run ledger only, never re-proposed this run, nothing written to GitHub.
- **At drain**, filing tickets re-opens a drained DAG — so the final fork is explicit: ship the new tickets in this run, or leave them filed for a future one.

## Point E — the rate-limit-window fork, and rate-limit-death recovery (resume in place, never re-run the engine)

A rate-limit death is a distinct failure shape from a model failure: the session didn't get anything wrong, it ran out of window mid-work. Step 4 preflights the five-hour window before every engine invocation (`scripts/rate-limit-preflight.mjs`, threshold 0.8) so this should be rare, but the preflight is a heuristic over the *newest* known utilization, not a guarantee — a wave can still start clean and cross the threshold mid-run, or the preflight's source can be stale/absent (it fails open). When step 5 classifies a `failed`/`blocked` row's `failureReason` as `"rate-limited"` (via `classifyFailureReason` in `scripts/lib/rate-limit.mjs` — the report row's structured field when present, else the transcript signature), treat it as an infra failure and follow this recipe rather than the HITL point B grill:

1. **Diagnose from the session log.** Tail `<stateDir>/state/logs/issue-<url-encoded-ref>.log` (the engine percent-encodes the ref, e.g. `issue-owner%2Frepo%23N.log`) for the signature: a `rate_limit_event` line whose `rate_limit_info.status` is `"rejected"`, and/or the CLI's synthetic rate-limit assistant turn (`error: "rate_limit"`, text "You've hit your session limit") — this is what `isRateLimitDeath` checks. The rejected event's `rate_limit_info.unifiedWindows.five_hour.resetsAt` (epoch seconds) is the window's reset time.
2. **Confirm the worktree survived.** The engine's per-issue worktree (`<stateDir>/worktrees/<ref>/...`) is untouched by the death — the session's own commits, if any, are still there. `git -C <worktree> log --oneline -5` and `git -C <worktree> status` to see how far it got before the window closed. Do **not** delete or reset this worktree.
3. **Wait for the reset — or fork to point E.** If `resetsAt` is soon, wait for it (the same wait-vs-ask fork trigger 6 names, shared with the step-4 preflight: print the time, wait if it's within `--wait-max-minutes`, otherwise **this is the point-E grill** — wait / defer / stop).
4. **Launch a continuation agent into the *existing* worktree/branch** — never re-run the engine for that issue. Re-running would create a second worktree/branch and collide with the one the dead session already pushed to (or left committed locally). Carry forward whatever blocking context the dead session was working through when it died (e.g. a pre-PR hook's review text, an open review comment) so the continuation doesn't repeat work or lose the thread. The continuation agent finishes the same implement→push→PR sequence the Implement subagent block describes, from where the dead session left off.
5. **Telemetry — emitted at death time, not deferred until the outcome is known.** The instant step 5 classifies the row as rate-limited, emit its record immediately: `implStatus: "error"`, `failureReason: "rate-limited"` (see `scripts/telemetry.mjs`). This happens even though the issue isn't actually abandoned — it's resumed in place via the continuation agent above — because the death itself is real telemetry about the window, independent of whatever the continuation later does. If the continuation succeeds, the issue's eventual `merged` telemetry record is a *separate*, ordinary step-6 emission for the same issue — the rate-limited attempt is not re-recorded as a bounce on it. `report()` excludes every `failureReason: "rate-limited"` record from the model-quality indicators (first-pass yield, triage-miss, bounce rate) — an infra death must never make those numbers look worse than the model actually performed — and tallies it instead in the report's `quotaFailures` count (see *Telemetry* in `SKILL.md`).

## What does NOT escalate

- PLAUSIBLE (unconfirmed) findings, or findings outside `--block-on` categories — surfaced in the summary, not blocking.
- Retro items the subagent judged not worth a ticket — its block demotes them to `observations` (payoff-ranked, ≤5 proposals typical); observations never grill, they ride the wave summary. A PLAUSIBLE proposal that *did* make the cut still grills — confidence is surfaced at point D, not filtered before it.
- Cosmetic nits — listed for the human, never block a merge.
- A CONFIRMED finding the reviewer itself marked `blocking: false`, outside `correctness`/`security` — scored as a nit, and named in the gate's `selfClearedCount`/`selfCleared[≤3]` so the human can second-guess the downgrade in the wave summary without it stopping the wave.
- A green PR — auto-merges under the requester-authorized policy (see the skill's Merge queue).
