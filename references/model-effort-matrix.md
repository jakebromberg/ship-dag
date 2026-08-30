# Model & effort matrix

Two independent axes. **Model = capability floor** (Haiku → Sonnet → Opus). **Effort = deliberation depth** (`low → medium → high → xhigh → max`). They compose — Opus-low is a strong model thinking briefly; Haiku-high is a weak model straining. Spend effort only where the step needs real reasoning *and* its mistakes are not cheaply caught downstream, so terminal/gate steps get effort and bookend/mechanical steps stay cheap under defense-in-depth.

## Per-step defaults and dynamic modifiers

| Step | Model | Default effort | Escalate to | De-escalate to |
|---|---|---|---|---|
| Triage / read | `haiku` | low | **medium** — long body, many cross-refs, or `epic`/`complex` label | — |
| Implement | `sonnet` | medium | **high** — triage tagged complex (multi-file, algorithmic, concurrency, schema/migration, public-API, security surface) | **low** — purely mechanical (config/string/dep bump, single file, no logic) |
| Review — Verify pass | `opus` | medium | **high** — the decisions are themselves subtle, or the impl resolved open questions unilaterally | never below medium |
| Review — Explore pass | `opus` | by **reach** (below): `in-diff` medium · `repo` high · `external` xhigh | **max** — a wrong answer is unrecoverable *and* reach is `external` (bulk writes to production data, a credential path, a migration) | never below medium, and never below high once `reach` is `repo` |
| Retrospective | `opus` | high (nominal) | **xhigh (nominal)** — merged surface spans repos, > ~10 PRs, or touches a security surface | never below high — misses here are caught by nobody (point D only filters false positives; it cannot restore an unseen finding) |
| Merge | main agent (no subagent) | low (n/a) | rebase re-gate re-runs the review at *that issue's* review effort | — |

The triage subagent emits a **complexity score** (`mechanical | normal | complex`) per issue; that score is the input that sets the implement effort. Tiers are chosen per issue, not hardcoded.

**Model is never the review dial.** Both review passes are `opus`, always. The model is what supplies the judgment that finds a defect nobody enumerated; dropping to a cheaper model to save tokens trades away exactly the capability the gate exists for. Tier on **effort**, which buys deliberation depth without lowering the ceiling.

### Review `reach` — the effort rubric

`reach` asks **how far the reasoning has to travel from the diff to reach a verdict.** It is deliberately a property of the change, not of how alarming the subject sounds: "touches auth" is a vibe, "the verdict requires reading a third-party library's source" is checkable, and only the second predicts how long the reviewer has to think.

| `reach` | The verdict needs… | Explore effort |
|---|---|---|
| `in-diff` | only the diff and the issue | medium |
| `repo` | the surrounding code — callers, schema, sibling services, the lockfile | high |
| `external` | third-party internals, arithmetic against a production-scale population, or a cross-repo contract closure | xhigh |

Worked examples, all real: a contract-pin bump whose one live risk was tracing every reader of a single `@State` var in one file → `in-diff`. An endpoint whose findings needed the SQL, the roles file, and the lockfile → `repo`. A bulk-write job whose blocking defect only appears once you count a function's columns, read the ORM's source to learn nulls become bind parameters, read the driver's source for the int16 cap, and divide into the stated population size → `external`. Nothing in that last diff hints that any of it is required, which is the point: `reach` is a judgment made *before* the review, so make it generously.

The **retrospective** still runs as an inline `Agent` from the main agent, so its effort remains *nominal* (prompt-approximated; see the actuation caveat). The "reason exhaustively across the merged surface" framing in the retro block is that approximation. `--retro-threshold` **amortizes** rather than caps cost: it sets how much merged surface accumulates before a pass runs (a higher N means fewer but strictly larger passes), and the plan half of a pass scales with the remaining DAG, untouched by the flag.

## Guardrails

1. **Never crank effort on a weak model.** If you're reaching for high effort on Haiku, promote the model instead — Sonnet-low beats Haiku-high per token.
2. **Escalate on failure, per item.** When the Opus gate bounces a PR, the `/review-loop` fix pass re-runs *that issue's* implement one tier higher; the rest of the wave stays at default.

## Actuation caveat

`effort` is a real parameter in two places: the engine config for **implement** sessions (per-issue `model`/`effort` → `--model`/`--effort` on each session), and `agent(prompt, { effort })` inside any workflow script — which now covers **review on the primary path**, since step 4d routes it through `review-workflow.js` rather than an inline fan-out. That was the gap this caveat used to describe, and closing it was the point: review is the step where under-deliberating is unrecoverable, so it is the last place effort should have been prompt-approximated.

The inline `Agent` tool still has **no `effort` parameter**. What remains nominal, therefore: the **retrospective** (always inline), the **review fallback** when the `Workflow` tool isn't available to the session, and the **triage** gate. There effort is approximated by (a) the model choice and (b) prompt framing ("reason exhaustively about correctness and edge cases" vs "make the mechanical change"). When a run takes the review fallback, say so in the wave summary — a reader comparing two runs' findings deserves to know one of them had a softer gate.
