# Model & effort matrix

Two independent axes. **Model = capability floor** (Haiku → Sonnet → Opus). **Effort = deliberation depth** (`low → medium → high → xhigh → max`). They compose — Opus-low is a strong model thinking briefly; Haiku-high is a weak model straining. Spend effort only where the step needs real reasoning *and* its mistakes are not cheaply caught downstream, so terminal/gate steps get effort and bookend/mechanical steps stay cheap under defense-in-depth.

## Per-step defaults and dynamic modifiers

| Step | Model | Default effort | Escalate to | De-escalate to |
|---|---|---|---|---|
| Triage / read | `haiku` | low | **medium** — long body, many cross-refs, or `epic`/`complex` label | — |
| Premise-check (step 3a) | `sonnet` | medium (nominal) | **high (nominal)** — the premise spans repos, or turns on a migration/schema history rather than a call graph | — |
| Implement | `sonnet` | medium | **high** — triage tagged complex (multi-file, algorithmic, concurrency, schema/migration, public-API, security surface) | **low** — purely mechanical (config/string/dep bump, single file, no logic) |
| Review | `opus` | high | **xhigh–max** — large diff, security surface, or impl resolved open questions unilaterally | never below high |
| Retrospective | `opus` | high (nominal) | **xhigh (nominal)** — merged surface spans repos, > ~10 PRs, or touches a security surface | never below high — misses here are caught by nobody (point D only filters false positives; it cannot restore an unseen finding) |
| Merge | main agent (no subagent) | low (n/a) | rebase re-gate re-runs the review at *that issue's* review effort | — |

**Premise-check is Sonnet, not Haiku, and this is the one place the matrix pays *up* for a read-only step.** It is the pass that decides which questions reach the human at point A, and both of its failure modes are expensive: a premise wrongly refuted ships an issue on a false understanding of the code, and a premise wrongly confirmed spends a human's attention on a question the code already answered. It is also the step whose output most directly replaces main-context file-reading — the whole point is that its conclusions are trustworthy enough that nobody re-derives them. Haiku already had its turn at this issue during triage; running the check on the same tier would mostly reproduce triage's guesses.

The triage subagent emits a **complexity score** (`mechanical | normal | complex`) per issue; that score is the input that sets the implement effort, via the `implement` map in `tuning.json` (emit-config stamps it as an explicit `effort`; the engine's retry escalation still applies on top). Tiers are chosen per issue, not hardcoded.

The retrospective always runs as an inline `Agent` fan-out from the main agent, so its effort is *nominal* (prompt-approximated; see the actuation caveat below) — as is the review gate's on the engine path, where review also runs inline from the skill. The "reason exhaustively across the merged surface" framing in the retro block is that approximation. `--retro-threshold` **amortizes** rather than caps cost: it sets how much merged surface accumulates before a pass runs (a higher N means fewer but strictly larger passes), and the plan half of a pass scales with the remaining DAG, untouched by the flag.

## Guardrails

1. **Never crank effort on a weak model.** If you're reaching for high effort on Haiku, promote the model instead — Sonnet-low beats Haiku-high per token.
2. **Escalate on failure, per item.** When the Opus gate bounces a PR, the `/review-loop` fix pass re-runs *that issue's* implement one tier higher; the rest of the wave stays at default.

## Actuation caveat

`effort` is a real parameter on the engine path for **implement** sessions (per-issue `model`/`effort` in the emitted config → `--model`/`--effort` on each session; the review gate on that path runs inline from the skill, so review effort there is nominal) and on the `workflow.js` path for both implement and review (`agent(prompt, { effort })`). The inline `Agent` tool (the baseline fan-out, the engine-path review gate, and the retrospective always) has **no `effort` parameter**, so there effort is approximated by (a) the model choice and (b) prompt framing ("reason exhaustively about correctness and edge cases" vs "make the mechanical change"). If a strict per-step effort contract matters for a run, lower the `workflow.js` threshold to ≥1 so every wave routes through it — traded against workflow startup overhead on tiny waves.
