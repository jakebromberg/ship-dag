# Escalation policy — when to grill the human

`/ship-dag` runs autonomously *except* at four human-in-the-loop points — A (triage), B (implement/review), C (cross-repo cutover), D (retrospective). A and B fire when the design premise breaks — a well-specced issue Sonnet-implements and survives the Opus gate cleanly; **when that premise breaks, that break is the escalation signal.** C and D are **scheduled gates** built into the loop.

## Triggers (any one → pause and grill)

1. **Underspecced issue** — triage (or the implement subagent) cannot resolve an ambiguity from the issue body + repo conventions. A guess would be a coin flip on intent.
2. **Architectural fork or new dependency** — the work forces a design choice with lasting consequences, or pulls in a new third-party dependency.
3. **Unclearable blocking finding** — the Opus gate returns a CONFIRMED finding in a `--block-on` category that `/review-loop` cannot clear within `--max-review-iter`, or that needs a design decision rather than a mechanical fix.
4. **Non-flaky CI failure** — CI fails for a real reason (not a known-flaky/infra retry). Per global rules, ≤2 manual retries on infra failure, then stop — never loop.
5. **Merge conflict needing judgment** — a rebase conflict whose resolution isn't mechanical.

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

## What does NOT escalate

- PLAUSIBLE (unconfirmed) findings, or findings outside `--block-on` categories — surfaced in the summary, not blocking.
- PLAUSIBLE retro proposals with thin evidence — the Retrospective subagent is told to drop them to `observations`; observations never grill, they ride the wave summary.
- Cosmetic nits — listed for the human, never block a merge.
- A green PR — auto-merges under the requester-authorized policy (see the skill's Merge queue).
