# Escalation policy — when to grill the human

`/ship-dag` runs autonomously *except* at two human-in-the-loop points. The whole design premise is that a well-specced issue Sonnet-implements and survives the Opus gate cleanly; **when that premise breaks, that break is the escalation signal.**

## Triggers (any one → pause and grill)

1. **Underspecced issue** — triage (or the implement subagent) cannot resolve an ambiguity from the issue body + repo conventions. A guess would be a coin flip on intent.
2. **Architectural fork or new dependency** — the work forces a design choice with lasting consequences, or pulls in a new third-party dependency.
3. **Unclearable blocking finding** — the Opus gate returns a CONFIRMED finding in a `--block-on` category that `/review-loop` cannot clear within `--max-review-iter`, or that needs a design decision rather than a mechanical fix.
4. **Non-flaky CI failure** — CI fails for a real reason (not a known-flaky/infra retry). Per global rules, ≤2 manual retries on infra failure, then stop — never loop.
5. **Merge conflict needing judgment** — a rebase conflict whose resolution isn't mechanical.

## Protocol

`grill-me` is inherently interactive and one-question-at-a-time, and the orchestrator is *already* the interactive agent — so conduct the interview **inline** rather than spawning `grill-me` (which would hijack the turn). Steps:

1. **Batch, don't drip.** At the triage gate (HITL point A), collect *all* underspecced questions across the wave and grill once, not per-issue.
2. **Give full context** — the issue, the relevant diff/finding, and why the autonomous path stopped. Use `AskUserQuestion` for crisp forks (2–4 options, recommended first); use an inline grill-me-style interview for open-ended design questions.
3. **Persist the resolution** as a GitHub issue comment (ghost-writer: no Claude/AI attribution), and update the issue body if scope changed — so peers and future waves inherit the decision.
4. **Resume the wave** with the decision applied. Only genuinely cleared issues proceed to implementation.

Suggest the user run `/grill-me` themselves if they want the full adversarial treatment on a thorny fork.

## What does NOT escalate

- PLAUSIBLE (unconfirmed) findings, or findings outside `--block-on` categories — surfaced in the summary, not blocking.
- Cosmetic nits — listed for the human, never block a merge.
- A green PR — auto-merges under the requester-authorized policy (see the skill's Merge queue).
