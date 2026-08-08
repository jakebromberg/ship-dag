# Model & effort matrix

Two independent axes. **Model = capability floor** (Haiku → Sonnet → Opus). **Effort = deliberation depth** (`low → medium → high → xhigh → max`). They compose — Opus-low is a strong model thinking briefly; Haiku-high is a weak model straining. Spend effort only where the step needs real reasoning *and* its mistakes are not cheaply caught downstream, so terminal/gate steps get effort and bookend/mechanical steps stay cheap under defense-in-depth.

## Per-step defaults and dynamic modifiers

| Step | Model | Default effort | Escalate to | De-escalate to |
|---|---|---|---|---|
| Triage / read | `haiku` | low | **medium** — long body, many cross-refs, or `epic`/`complex` label | — |
| Implement | `sonnet` | medium | **high** — triage tagged complex (multi-file, algorithmic, concurrency, schema/migration, public-API, security surface) | **low** — purely mechanical (config/string/dep bump, single file, no logic) |
| Review | `opus` | high | **xhigh–max** — large diff, security surface, or impl resolved open questions unilaterally | never below high |
| Retrospective | `opus` | high (nominal) | **xhigh (nominal)** — merged surface spans repos, > ~10 PRs, or touches a security surface | never below high — misses here are caught by nobody (point D only filters false positives; it cannot restore an unseen finding) |
| Merge | main agent (no subagent) | low (n/a) | rebase re-gate re-runs the review at *that issue's* review effort | — |

The triage subagent emits a **complexity score** (`mechanical | normal | complex`) per issue; that score is the input that sets the implement effort. Tiers are chosen per issue, not hardcoded.

The retrospective always runs as an inline `Agent` fan-out from the main agent — the one path where effort is *nominal* (prompt-approximated; see the actuation caveat below): the "reason exhaustively across the merged surface" framing in its block is that approximation. Its cost is bounded by `--retro-threshold`, not wave size — a pass runs at most once per wave, over an already-thresholded surface.

## Guardrails

1. **Never crank effort on a weak model.** If you're reaching for high effort on Haiku, promote the model instead — Sonnet-low beats Haiku-high per token.
2. **Escalate on failure, per item.** When the Opus gate bounces a PR, the `/review-loop` fix pass re-runs *that issue's* implement one tier higher; the rest of the wave stays at default.

## Actuation caveat

`effort` is a real parameter on the engine path (per-issue `model`/`effort` in the emitted config → `--model`/`--effort` on each session) and on the `workflow.js` path (`agent(prompt, { effort })`). The inline `Agent` tool (the baseline fan-out) has **no `effort` parameter**, so on that path effort is approximated by (a) the model choice and (b) prompt framing ("reason exhaustively about correctness and edge cases" vs "make the mechanical change"). If a strict per-step effort contract matters for a run, lower the `workflow.js` threshold to ≥1 so every wave routes through it — traded against workflow startup overhead on tiny waves.
