---
name: ship-dag
description: Ship a dependency DAG of GitHub issues to main — per-issue subagents (Haiku triage, Sonnet implement, Opus review), auto-merge on green (rebase-and-merge), and HITL grilling on any open question. Use when the user wants to autonomously work through an epic or a set of dependent issues end to end.
argument-hint: "[epic#N | --label L | org/repo#N ...] [--org O] [--block-on correctness,security] [--max-review-iter 2] [--workflow-threshold 5] [--retro-threshold 3] [--no-retro] [--dry-run]"
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, Agent, Skill, AskUserQuestion
---

# Ship a DAG of issues

Walk a dependency DAG of already-filed GitHub issues to `main`, **one wave at a time**. Each issue flows through the cheapest capable subagent — Haiku triage, Sonnet implement, Opus review — and lands via rebase-and-merge, **auto-merged on green**. The skill (you, the main agent) owns everything human-facing and stateful: DAG discovery, the ready-set, the HITL gates, and the dependency-ordered merge queue. The expensive parallel implement→review work fans out to subagents.

The premise: a well-specced issue Sonnet-implements and survives the Opus gate cleanly. When that premise breaks — an ambiguous spec, a blocking finding, a CI/merge failure — **that break is the signal to stop and grill the human** (see `references/escalation-policy.md`).

## When NOT to use

- **One issue, one PR** — just implement it directly.
- **Issues aren't filed yet** — run `/file-ticket` or `/to-issues` first; this skill ships an existing DAG, it doesn't invent one.
- **Exploratory / design-unsettled work** — the DAG must be real dependencies between specced issues, not a research spike.
- **Anything irreversible outside the merge itself** (data migrations gated on manual cutover, infra changes) — ship those by hand.

## Arguments

Parse `$ARGUMENTS` into an **issue set**, an **org default**, and **flags**.

Issue set — one of:
| Form | Meaning |
|---|---|
| `epic#N` / `org/repo#N` | A tracking/epic issue; the DAG is its native sub-issue tree, at any depth. |
| `--label L` | Every open issue in the repo carrying label `L`. |
| `org/repo#12 repo#15 #20` | An explicit set of issue numbers. |

**Org/repo resolution** (no silent org guess):
1. A fully-qualified `owner/repo#N` always wins.
2. Otherwise infer the repo from the current working directory: `gh repo view --json nameWithOwner -q .nameWithOwner`.
3. Otherwise use `--org O` with the bare `repo`. If none of these resolve, **stop and ask** — do not default to an arbitrary org. ship-dag never assumes a particular org: the org checkout root (the dir holding repo siblings) is derived from the resolved repo's checkout — the parent of `git rev-parse --show-toplevel` — and can be overridden with `SHIP_DAG_REPOS_DIR` (see step 4).

The issue set may span repositories. Every node is keyed on its **composite ref** (`owner/repo#N`, or a bare `N` only in a single-repo run), so the same number in two repos stays two distinct nodes and a cross-repo dependency edge is honored end to end. A wave that crosses a repo boundary triggers the cutover gate in step 7.

Hand refs to `/review-loop` as **fully-qualified `owner/repo#N`**: it infers a default org for a bare `repo#N` and looks for the checkout as a sibling of the current working tree (falling back to `gh repo clone`), so a fully-qualified ref keeps it on the right repo. `/cleanup` is org-agnostic — it operates on the current repo's `git worktree list` and detects the default branch dynamically — so it needs no special qualification, but passing it the same fully-qualified ref is harmless.

Flags:
- `--block-on correctness,security` (default) — finding categories that block auto-merge. See `references/review-schema.md`.
- `--max-review-iter K` (default `2`) — `/review-loop` fix passes before escalating a blocking finding.
- `--workflow-threshold N` (default `5`) — **fallback only** (engine unavailable, step 4): a wave with ≥ N cleared issues routes the fallback implement→review through `workflow.js`; below it, inline `Agent` fan-out. Ignored on the primary engine path.
- `--retro-threshold N` (default `3`) — run the step-6.5 retrospective once ≥ N merged PRs have accumulated since the last pass; below N the wave skips it and carries the count forward. A final pass always runs at drain if any unretrospected merges remain. `--no-retro` disables the step entirely (including the drain pass).
- `--dry-run` — print the full wave partition (`waves` / `blocked` / `cyclic`), the per-issue model/effort assignment, and the retro configuration (threshold / disabled), then stop **before any side effect** — step 6.5 never executes on a dry run.

## The wave loop

`SD=$HOME/.claude/skills/ship-dag`. At run start, **mint the run id with the script, not in your head** — `export SHIP_DAG_RUN_ID=$(node "$SD/scripts/telemetry.mjs" run-id)` (add `--label <slug>` to make it self-describing; the command echoes an already-exported `SHIP_DAG_RUN_ID` unchanged, so re-running it after a resume is safe). Every later command reads it from the environment or off the run's own artifacts, so per-run grouping no longer depends on you remembering a string across a compaction. Then initialize the run-scoped retro state: `U` (merged-but-unretrospected PR refs, appended in step 6), the wave counter `W` (1-based, incremented on each pass through step 1), and the proposal ledger (retro-filed refs, declined proposals) — step 6.5 consumes and feeds all three. Repeat until the DAG is drained or everything left is blocked on a HITL decision:

### 1. Discover / refresh the DAG

- Run `/recheck-issues` on the issue set first, so state moved by peers/humans since you last looked is picked up.
- **The graph math is delegated, not reimplemented.** `plan-waves.mjs` imports the shared composite-keyed topological-sort core (`readySet`/`layeredTopoSort`) from claude-orchestrator's built `dist/`, so this planner and the engine's `computeWaves` can't drift. Point `CO_HOME` at that checkout if it isn't the default `/Users/jake/Developer/claude-orchestrator`; the core must be built there (`npm run build` — `dist/` is committed, so a fresh clone already has it). If the import fails, the script errors with exactly that instruction.
- Build the spec into a temp file. **Single repo:** `SPEC=$(mktemp); node "$SD/scripts/plan-waves.mjs" fetch --repo owner/repo (--epic N | --label L) > "$SPEC"` (or pipe `fetch … | … plan -`). It emits `{ repo, nodes[], edges[], done[] }` keyed on **composite refs**: each node carries `{ number, repo, ref, bodyLen, refCount, labels }` (the last three feed the triage-effort decision), edges are `{ blocked, blockedBy }` ref pairs, and `done[]` holds refs. Sub-issues come from GraphQL `subIssues` (paginated, each keyed on its **own** `repository.nameWithOwner` — a cross-repo sub-issue stays in its home repo, not the epic's). The `--epic` walk is **recursive**: a sub-issue that is itself an epic is descended into, to any depth, in its own repo. Only the leaves become nodes — an intermediate epic is a grouping, not a unit of work, and shipping it would hand a whole sub-tree to one implement subagent. `subIssuesSummary.total` rides along in the parent's response, so a leaf costs no query of its own; a CLOSED sub-issue takes its whole sub-tree out of scope; a cyclic hierarchy terminates with a warning; and an epic whose own sub-issue query comes back unreadable is kept as a single node rather than silently dropped. **An open epic whose descendants are all closed ships as a node** — it isn't a grouping of pending work, it *is* the pending work. Edges are fetched automatically from **two** sources and merged: GitHub's native issue-dependency graph (each node's `blocked_by` list, via `gh api .../dependencies/blocked_by` — tolerant of a repo where it isn't configured or isn't visible to the token) and body-prose `Blocked by #N` / `Blocks #N` / `Depends on #N`, including both the adjacent-clause form ("Blocked by #12, #13 and #14", multi-issue **and** cross-repo `owner/repo#N` refs handled) and a `## Blocked by` / `## Depends on` heading followed by a bulleted list of refs; a bare `#N` is qualified to the citing issue's repo either way. On an `--epic` fetch, edges naming an epic are then rewritten — **before** the merged set is deduped on the `{blocked, blockedBy}` pair, since the rewrite itself can produce the same pair twice on top of the duplicates the two sources already contribute. The rewrite is needed because an epic never ships and so an edge left pointing at one could never be satisfied (it stays open until its last child closes) — stranding its dependent as permanently blocked: an edge between an issue and one of its **own ancestor epics** is containment ("this is part of that", which the native dependency graph surfaces as a `blocked_by` entry), so it is dropped in both directions; every other epic edge is **expanded onto the leaves** — "X is blocked by epic E" becomes "X is blocked by every leaf of E", and an epic's own blocker is pushed down onto each leaf that ships in its place. Closed/merged dependencies are resolved into `done[]`, each viewed in **its own** repo.
- **Multi-repo issue set** (an explicit `org/repo#12 other/repo#15 …` set, or a cross-repo epic): `fetch` takes one `--repo` per call, so fetch once per distinct repo (by `--epic`/`--label`, or hand-build the `nodes[]` for an explicit set) and **union** the results — concatenate `nodes[]`, `edges[]`, `done[]` into one spec, keeping a single top-level `repo` as the default for any still-bare ref. Unioning is safe precisely because every endpoint is a composite ref: same-numbered issues in different repos stay distinct and cross-repo edges survive. (The epic path already unions cross-repo sub-issues for you.)
- On a resumed session — or on an epic run where a cross-repo retro ticket could be attached only by prose (sub-issues are same-repo-only) — **re-union the run's retro-filed refs** into the spec if the fetch didn't surface them. The telemetry CLI has no read subcommand, so read the log file directly (`$SHIP_DAG_TELEMETRY`, else `$XDG_STATE_HOME/ship-dag/runs.jsonl`, else `~/.local/state/ship-dag/runs.jsonl`): the lines with this `runId` and `kind:"retro"` carry `filed[]` — and `declinedTitles[]`, for rebuilding the ledger.
- A dependency counts as satisfied when its issue is **merged or closed** (fetch already folds those into `done[]`) — but see step 7: a *cross-repo* dependency's merge is not enough to auto-release its downstream.

### 2. Compute the ready-set

- `node "$SD/scripts/plan-waves.mjs" plan "$SPEC"` → `{ waves, blocked, cyclic }` (entries are composite refs — `owner/repo#N`, or a bare `N` in a single-repo DAG).
- `waves[0]` is the current ready-set. If `cyclic` is non-empty or `blocked` lists external blockers while nothing is ready, **stop and report** — the DAG can't advance without human input.
- On `--dry-run`: print `waves`, the `blocked`/`cyclic` report, the model/effort each issue would get (per `references/model-effort-matrix.md`), and the retro configuration (threshold / disabled); then stop.

### 3. Triage gate — HITL point A

Fan out **one `Agent{model:"haiku"}` per ready issue, all in a single message** (read-only; see the Triage block). Each returns `{ clear | needs-decision, complexity, questions[], digest }`.

- Collect every `needs-decision` across the wave and **grill the user once** (batch, not per-issue) — `AskUserQuestion` for crisp forks, inline interview for open design questions (`references/escalation-policy.md`). Record each resolution as a GitHub issue comment (ghost-writer, no attribution); update the issue body if scope changed.
- Only **cleared** issues proceed. Carry each issue's `complexity` → implement effort and `digest` forward.
- **Telemetry:** carry every issue **deferred at this gate** into step 4a's spec as a `deferred[]` entry (`{ ref, complexity }`) — `emit-config.mjs` writes its point-A record (`finalState:"blocked-hitl"`, `hitl.pointA:true`, `implStatus`/`ciStatus`/`reviewVerdict` null) as a side effect of building the engine config, so the deferrals are logged by the command you have to run anyway rather than by a separate step. These point-A records are what make the triage-miss and HITL-A indicators measurable instead of survivor-only. See *Telemetry* below.

### 4. Implement fan-out — the engine implements, the skill reviews

The parallel **implement** work is delegated to the **claude-orchestrator engine** — per-repo worktrees + CI, per-issue model/effort, and its default `mergePolicy: "none"` (implement each issue in its own worktree, run that repo's CI, open a PR, then **STOP** — never merge). The **Opus review gate stays here**, as a ship-dag pass over the PRs the engine opens. `CO_HOME` points at the engine checkout (default `/Users/jake/Developer/claude-orchestrator`, the same core import as step 1).

**Preflight (before every engine invocation, including a retry).** A wave launched while the account's five-hour rate-limit window is already near-exhausted is near-certain to die mid-implement, at the most expensive possible moment. Run:
`node "$SD/scripts/rate-limit-preflight.mjs" check` (optionally `--base-dir`/`--threshold`/`--wait-max-minutes` to override the defaults — 0.8 utilization, 30-minute wait cap). It reads the newest `rate_limit_event` out of the newest-by-mtime session transcripts under `${XDG_STATE_HOME:-$HOME/.local/state}/ship-dag/engine/*/state/logs/issue-*.log` (every run's transcripts live under that one base dir — see step 4a), walking a few candidates newest-first — not just the single newest file — so a just-created, still-empty log can't shadow an older transcript that actually has a reading, and prints a JSON decision on stdout:
- `action: "proceed"` (below threshold, or no readable utilization source at all — **fail-open**: a fresh machine with no prior runs must not be blocked by absent telemetry) → continue to 4a.
- `action: "wait"` (at/above threshold, window resets within 30 minutes) → print `resetsAt`, sleep until it, then re-run the preflight and continue.
- `action: "hitl"` (at/above threshold, reset is further off or unknown) → **stop and grill the human — HITL point E**: wait / defer this wave / stop the run (`references/escalation-policy.md`).

**a. Emit the engine config.** Build a ready-wave spec (JSON): for each **cleared** issue `{ number, repo, ref, title, complexity, model?, effort?, digest, extraDirs? }` — carry triage's `complexity` (the engine derives effort from it); set `model`/`effort` only where triage or the rubric overrides. Add `repos` from `references/repo-ci-profiles.json` for the wave's distinct repos (each `{ baseBranch, commands }`; a repo absent there defaults to `main` + no CI — emit-config warns); `name: "ship-dag-$SHIP_DAG_RUN_ID"`; an absolute per-run `stateDir` **outside any repo** (`${XDG_STATE_HOME:-$HOME/.local/state}/ship-dag/engine/$SHIP_DAG_RUN_ID` — suffix it `-w<W>` per wave if you keep waves apart, which the telemetry audit folds back to the run); `projectRoot` = the org checkout root `$PROJECT_ROOT`, derived once as `PROJECT_ROOT="${SHIP_DAG_REPOS_DIR:-$(dirname "$(git rev-parse --show-toplevel)")}"` — the parent of the target repo's checkout in the sibling layout; set `SHIP_DAG_REPOS_DIR` to override (e.g. a meta-repo root like `/Users/jake/Developer/daisyguide`); `promptTemplate` = `$SD/scripts/engine/prompt.md`. Also carry the telemetry half the engine's own report can't reconstruct: `runId` (`$SHIP_DAG_RUN_ID`; optional — it otherwise falls out of `name`), `wave: W`, and `deferred[]`, the step-3 point-A deferrals as `{ ref, complexity }`. Then:
`node "$SD/scripts/emit-config.mjs" spec.json > "$STATE/config.json"`. Every ready-wave issue is independent, so emit-config gives each `dependsOn: []` — one flat wave the engine runs fully in parallel. Besides the config on stdout, the command drops `<stateDir>/ship-dag-wave.json` — the sidecar carrying the run id, the wave number, and each issue's complexity + assigned model, which step 6b's wave close reads back — and appends the point-A defer records. Both are best-effort: a failure warns on stderr and never blocks the wave.

**b. Invoke the engine.** Export `CO=${CO_HOME:-/Users/jake/Developer/claude-orchestrator}` once. Preview first (read-only, no side effects — the analog of `--dry-run`):
`SHIP_DAG_CONFIG="$STATE/config.json" CO_HOME="$CO" npx --prefix "$CO" tsx "$SD/scripts/engine/run.mts" wave --plan`
then run it:
`SHIP_DAG_CONFIG="$STATE/config.json" SHIP_DAG_PROJECT_ROOT="$PROJECT_ROOT" CO_HOME="$CO" npx --prefix "$CO" tsx "$SD/scripts/engine/run.mts" wave --parallel K`.
`SHIP_DAG_PROJECT_ROOT` also feeds the worktree layer's repos dir (via `reposDirFromEnv`'s fallback in `hooks.mts`), so this single env var keeps both the `--detach` respawn root and the per-repo worktrees under `$PROJECT_ROOT` — no WXYC path is assumed. Export `SHIP_DAG_REPOS_DIR` explicitly only if the two must differ.

**c. Read the report.** The engine writes `<stateDir>/state/reports/<id>.json`. Each row is keyed on the composite **`ref`** (`owner/repo#N`) — the disambiguator for same-numbered cross-repo issues — plus `number`, `status`, `prUrl`, `prNumber`. A `succeeded` row means the engine ran that repo's CI green before opening the PR (`retryOnCheckFailure` retried once, else the row is `failed`), so treat it as `ciStatus: "pass"` and map its `ref`→`prNumber` (branch via `gh pr view <PR> --json headRefName` if the review needs it). A `failed`/`blocked` row (no PR) is an implement stall → **HITL point B** (step 5). **Keep the report path** — `<stateDir>/state/reports/<ISO>.json` is the wave's durable record of what ran, and step 6b's telemetry close derives every mechanical field from it.

**d. Review pass (Opus — stays in the skill).** For each opened PR, run the **Review** subagent (the verbatim block below) over the PR's diff against **its own** base branch → `{ verdict, findings[] }`. This yields the same per-issue result the fallback paths do — `{ issue, ref, branch, pr, ciStatus, review:{ verdict, findings[] }, openQuestions[] }` — which step 5 reconciles.

**Fallback (engine unavailable — `CO_HOME` unset/unbuilt, or the invocation errors):** revert to the pre-C1 path. Cleared count ≥ `--workflow-threshold` **and** `Workflow` available → `Workflow({ scriptPath: "$SD/workflow.js", args: { repo, blockOn, issues: [{ number, digest, complexity, implEffort, reviewEffort }] } })`; else inline `Agent` fan-out (one Implement per issue in a single message, Review each as it returns). Both blocks are still present and produce the same result shape. The engine is preferred: it actuates per-issue effort literally, isolates per-repo worktrees + CI, and survives `--detach` — the fallback keeps ship-dag working without the engine checkout.

**Mixed-repo waves:** the engine handles them natively (per-issue `repo` → per-repo worktree, base branch, and CI), where `workflow.js` takes a single `repo` per batch. In practice a single ready wave rarely mixes repos, since cross-repo edges fall on wave boundaries where step 7's point-C gate already stops you.

### 5. Reconcile each result

- **Green** — CI pass, review `verdict` not `blocking`, no open questions → queue for merge.
- **Blocking finding** → `/review-loop owner/repo#PR --max-iter K` (from *you*, the main agent — reliable Skill access). Converges to green → queue. Doesn't clear within `--max-review-iter`, or needs a design call → **HITL point B**. On a bounce, the retried implement runs one effort tier higher (rubric guardrail 2).
- **`failed`/`blocked` row, no PR** — classify before routing to HITL: prefer the report row's `failureReason` field when present (claude-orchestrator#87); else call `classifyFailureReason` (`scripts/lib/rate-limit.mjs`) with the failed issue's transcript (`<stateDir>/state/logs/issue-<url-encoded-ref>.log` — the engine percent-encodes the ref, e.g. `issue-owner%2Frepo%23N.log`), which falls back to parsing that transcript for the rate-limit-death signature (a rejected `rate_limit_event`, or the CLI's synthetic rate-limit turn). `"rate-limited"` → **infra failure, not a model failure**: ≤2 manual retries, resume-in-place per the point-E recovery recipe in `references/escalation-policy.md` (never re-run the engine for that issue — it would collide with the existing branch; a wait that runs long forks to the point-E grill, not point B). Any other reason → **HITL point B**.
- **Open question surfaced mid-implementation / non-flaky CI failure / judgment-needing merge conflict** → **HITL point B** (grill), then re-queue or defer the issue.
- **Telemetry:** record the outcome of every issue that **terminates here** without merging (`blocked-hitl` / `deferred` / `error`) in the wave's outcomes map — `{ finalState, reviewVerdict, findings[], bounces, hitl: { pointB: true }, failureReason }` keyed on the composite ref. Step 6b writes it; `implStatus`, `ciStatus`, `complexity`, `assignment` and `pr` are derived from the engine's report and sidecar, so don't re-type them. A `"rate-limited"` `failureReason` record may additionally be `append`ed **at death time** regardless of what happens next (the wave close dedupes it) — even though the issue isn't actually abandoned, it's resumed in place per the recovery recipe (`references/escalation-policy.md`'s point E) and, if the continuation succeeds, gets a *second*, ordinary `merged` record at step 6 for the same issue. `report()` (`scripts/telemetry.mjs`) excludes `"rate-limited"` records from the model-quality indicators so this interim record never dilutes them — see *Telemetry* below.

### 6. Merge queue — auto on green

**a. Merge.** Side-effecting; all on you, the main agent; serialized in **dependency order**. Per queued PR:

1. `git fetch`; rebase the PR branch onto the latest tip of **its own repo's base branch** — not a hardcoded `main`. Resolve it per repo (`gh repo view owner/repo --json defaultBranchRef -q .defaultBranchRef.name`, or `git rev-parse --abbrev-ref origin/HEAD`); e.g. `wxyc-ios-64` is `master`.
2. **If the rebase moved the base** (a sibling from this wave already merged under it — the normal dependent-wave case): **re-run BOTH local CI and the Opus review gate** and re-check `--block-on` before merging. A verdict computed pre-rebase does not carry over once the base changed. If the re-gate now finds a blocking issue, pull the PR back into step 5.
3. `gh pr merge --rebase`.
4. `/cleanup owner/repo#PR` — remove the worktree, delete the branch, fast-forward, prune.
5. **Telemetry:** record the merged issue's outcome in the wave's outcomes map — `{ finalState: "merged", reviewVerdict, bounces }`, with the **worst** `reviewVerdict` seen for the issue (a bounced-then-merged issue logs `blocking`, not the post-fix `clean`, so triage-miss and review-catch stay measurable rather than survivor-biased).
6. Append the merged issue's ref and PR number to `U`, the run's unretrospected-merge list — the input to step 6.5.

**Never loop-retry a failing CI or merge.** ≤2 manual retries on an infra failure, then stop and surface the failure + cost. No `while`-loops against a red run.

**b. Close the wave — one call, the whole wave.** Once the queue is drained, write the outcomes map to a file and hand it to the ingest command with the engine report from step 4c:
`node "$SD/scripts/telemetry.mjs" ingest-wave "$STATE/state/reports/<ISO>.json" --outcomes @outcomes.json`
It derives `runId`, `repo`, `issue`, `complexity`, `triageStatus`, `assignment`, `path`, `implStatus`, `ciStatus`, `pr` and `ts` from the report plus the step-4a sidecar, and takes only the judgement half from your outcomes — so a whole wave costs one call and the mechanical fields cannot be mistyped. **Every issue in the report needs an outcome**: a half-supplied wave is refused with the forgotten refs named and *nothing* written, so fill in the rest and re-run rather than letting the wave shrink silently. Re-running a close that already landed is a no-op (records are deduped on `runId + repo#issue + finalState + failureReason`). Add `--dry-run` to see the records without writing. If the command errors for any other reason, note it and move on — telemetry is best-effort and must never stop the run.

### 6.5 Retrospective — HITL point D

Per-PR review is structurally blind to cross-PR problems: parallel implementers in separate worktrees cannot see each other's work, and the plan's remaining specs were written before this wave's code existed. This pass looks at the run holistically — after the merge queue, before advancing.

**Trigger:** skip unless `|U| ≥ --retro-threshold` (default 3 merged PRs; print the carry-forward count when skipping). **Always run once at drain** — when step 7's stop condition is met with `|U| > 0` — regardless of threshold. `--no-retro` disables both. A pass consumes `U` (reset to empty) whatever it finds, and emits one `kind:"retro"` telemetry record.

**Fan out ONE `Agent{model:"opus"}`** (read-only; the Retrospective block below — this block has exactly one copy, here) with: the merged issue refs + PR numbers in `U`, rendered as `owner/repo#N (PR #M)` pairs so `gh pr diff` has the PR number (all repos); the remaining DAG (`nodes[]` refs+titles and `edges[]` from the current spec, **minus every issue merged this run** — the spec predates this wave's merges, so without the subtraction the plan pass would audit just-shipped issues as pending); the run's issue-set form (epic / label / explicit set); and the run ledger (previously filed retro-ticket refs, previously declined proposals). It returns `references/retrospective-schema.md`: `{ mergedPrs, refactors[], planAdjustments[], observations[] }` — the main agent stamps `wave: W` when emitting the telemetry record; the subagent never produces it.

**HITL point D** (protocol in `references/escalation-policy.md`): if `refactors` and `planAdjustments` are both empty, print `observations` in the wave summary and move on — no grilling. Otherwise **batch everything into one grilling**, mirroring point A:

1. Present refactors via `AskUserQuestion` with `multiSelect` — one option per proposal (title + one-line summary + evidence PR refs), recommended-first; ≤4 options per question, paginate if more. Plan adjustments likewise; an open-ended `respec` gets the inline grill-me-style interview instead of a checkbox.
2. **Approved refactors** → ghost-write one ticket each via `/file-ticket`, **in the refactor's `repo`** — never the cwd default, which on a multi-repo run may contain none of the code (the drafted `body`; the `complexity` tier as triage context) — then insert into the run's DAG by issue-set form: **epic run** — attach as a native sub-issue of the epic (sub-issues are same-repo only; a cross-repo refactor ticket instead gets a prose `## Related` link to the epic AND is appended to the in-context set explicitly); **`--label L` run** — apply label `L` to the new issue; **explicit-set run** — append the fully-qualified `owner/repo#N` to the in-context issue set. Encode each approved `blockedBy`/`blocks` edge **both ways** so step 1's two merged edge sources pick it up: the native dependency graph AND body prose (`Blocked by owner/repo#N`). A refactor whose implementation consumes another repo's just-merged artifact must also carry a `Blocked by` edge naming that **merged** upstream issue — fetch folds it straight into `done[]`, so it never blocks, but the cross-repo edge is what routes the ticket through step 7's point-C cutover gate instead of letting it auto-release against an unpublished artifact.
3. **Approved plan adjustments** → ghost-written issue comments recording the decision and reasoning; body edits where the spec changed (`respec`); native edge add/remove plus matching body-prose edit (`add-edge`/`drop-edge`); `gh issue close --reason "not planned"` with an explanatory comment (`obsolete` — the one destructive act: confirm it individually in the grilling, never inside a multiSelect batch); `split` files children via `/file-ticket` and respecs the parent.
4. **Declined proposals** → recorded in the run ledger only; nothing written to GitHub; never re-proposed this run.
5. Filed tickets flow into the next step-1 fetch and ship through the normal triage→implement→review pipeline — the retro itself never writes code and never merges.
6. **If the just-filed tickets are the only thing keeping the run alive** — this pass ran in drain mode, *or* it ran at threshold on what would otherwise be the run's final wave (ignoring the tickets it just filed, step 7's stop condition would hold) — ask one final crisp fork: ship them **in this run** (loop back to step 1) or **leave them filed** for a future `/ship-dag` invocation (run ends). Filing tickets must never silently extend a run that was about to end; this question is the loop's termination valve.

**Telemetry:** `append` one `kind:"retro"` record per pass (a run-scoped judgement about proposals a human just disposed of — no artifact on disk records it, so this is one of the three emissions that stay yours) — `{ kind:"retro", runId, wave: W, mergedPrs, proposedRefactors, approvedRefactors, declinedRefactors, proposedAdjustments, approvedAdjustments, declinedAdjustments, filed[], adjusted[], declinedTitles[] }` (see *Telemetry* below; `declinedTitles` persists the declined half of the ledger — titles only — so a resumed run can rebuild it, with point D backstopping near-duplicate re-proposals the title match misses).

### 7. Advance — HITL point C on any cross-repo cutover

Mark merged issues done; go to step 1. The re-fetched `done[]` will surface the next wave.

**Cross-repo cutover gate — "satisfied" ≠ "merged" across a repo boundary.** A merged upstream PR is not consumable downstream until it is published/deployed (e.g. `wxyc-shared` → GH Packages → `Backend-Service`; a BS deploy → the canary validates it live). So when a newly-ready issue becomes ready **because a dependency in a *different* repo just merged**, do **not** auto-release it — **stop and grill the human** to confirm the upstream artifact is actually consumable (package published, service deployed, migration cut over), or that a named gate command succeeded, before triaging/implementing that dependent. Same-repo edges keep releasing automatically; only an edge crossing a repo boundary (or into a manual deploy/publish step) gates here. This mirrors the "anything irreversible outside the merge itself → ship it by hand" rule. A deferral here `append`s a `blocked-hitl` telemetry record, as at point B — this gate fires on issues that never entered a wave, so there is no engine report to derive it from.

Stop when `waves` is empty (drained) or the only remaining issues are blocked on a HITL decision you've already surfaced. **When the stop condition holds and `|U| > 0`, execute the step-6.5 block once more (drain mode) before the wave summary** — its substep-6 fork governs whether the loop returns to step 1 (ship the just-filed tickets now) or the run ends (leave them filed).

At the end, print a **wave summary**: per issue — final state (`merged` / `blocked-hitl` / `deferred` / `error`), PR number, review verdict, and any nits or routed findings for the human; and per retrospective pass — proposals made/approved/declined, tickets filed (refs), plan adjustments applied, and any `observations`. Then run `node "$SD/scripts/telemetry.mjs" audit` and report its `unrecorded` count: it walks every engine wave report on disk and names the rows that never reached the log. A non-zero count on *this* run's waves means a close was skipped or refused — the reports are durable, so re-run `ingest-wave` against the named report rather than writing the wave off.

---

## Subagent instruction blocks

Include the relevant block **verbatim** in each subagent's prompt (the inline fallback path). The **Implement** block has two other copies — `scripts/engine/prompt.md` (the engine's template, the primary path) and `workflow.js` (the accelerator fallback); the **Review** block is mirrored in `workflow.js`. Keep all copies in sync when editing. The Review block runs from the skill on every path (the engine implements only), so it is the one block that is never skipped. The **Retrospective** block has exactly **one** copy (below): it always runs from the main agent after the merge queue on every path — engine, workflow, and inline — so there is no mirror to keep in sync.

### Triage (Haiku, read-only)

> **Task:** Read GitHub issue `{OWNER/REPO}#{N}` and its linked context. Decide whether an implementer could proceed without guessing at intent. Do **not** write code or touch the repo.
>
> 1. `gh issue view {N} --repo {OWNER/REPO} --json title,body,labels`. Follow referenced issues (`#\d+`) enough to understand dependencies and scope.
> 2. Judge **clarity**: is the desired end state, the "where" (files/paths/symbols), and the acceptance criteria unambiguous? Flag any true open question (ambiguous spec, an architectural fork, a new third-party dependency) — not mere implementation latitude.
> 3. Judge **complexity**: `mechanical` (config/string/dep bump, single file, no logic) · `normal` · `complex` (multi-file, algorithmic, concurrency, schema/migration, public API, or security surface).
>
> **Return:** `{ status: "clear" | "needs-decision", complexity: "mechanical|normal|complex", questions: [ ... ], digest: "2-3 sentence implementation plan" }`.

### Implement (Sonnet, own worktree)

> **Task:** Implement `{OWNER/REPO}#{N}` in a fresh, disposable git worktree. Digest from triage: `{DIGEST}`.
>
> 1. Locate the repo checkout (sibling under `/Users/jake/Developer/`, else `gh repo clone`). `cd` in. Read repo + package `CLAUDE.md` and the patterns in the module you're touching; match them.
> 2. Test-first: failing test → smallest correct implementation → passing test. No drive-by refactors — every extra change is something the review will flag.
> 3. Run the repo's local CI (lint/format/typecheck/tests, or `npm run ci:*`). Fix red before pushing; never push known-red to bait the review.
> 4. Commit (**ghost-writer: no Claude/AI attribution anywhere**), push a dedicated branch, open a PR whose body contains `Closes #{N}` and cross-references the issue.
> 5. **If you hit a genuine open question mid-implementation** that the issue + repo conventions don't answer, STOP: return `status: "blocked"` with the questions — do **not** push a guess.
>
> **Return:** `{ issue, status: "pushed|blocked|error", branch, pr, ciStatus: "pass|fail|none", openQuestions: [ ... ], notes }`.

### Review (Opus, own worktree)

> **Task:** You are the last code-review gate before `{OWNER/REPO}#{N}` (PR `#{PR}`, branch `{BRANCH}`) reaches its base branch. Nothing downstream catches your misses — reason exhaustively.
>
> 1. In your worktree: `cd` into the checkout, `git fetch`, `gh pr checkout {PR}` (or check out `{BRANCH}`).
> 2. Review the PR against **its own base branch** (`git diff origin/$(gh pr view {PR} --json baseRefName -q .baseRefName)...HEAD`, or simply `gh pr diff {PR}`) — do not assume `main`; this repo's base may be `master`. Cover correctness, security, simplification, efficiency, and test coverage.
> 3. Optionally, if the Skill tool is reachable, also run the built-in `/code-review` and union its findings. If not reachable, your inline review stands alone.
> 4. Classify per `references/review-schema.md`: `verdict: "blocking"` if any finding is CONFIRMED in a `--block-on` category (`{BLOCK_ON}`); `"nits-only"` if only non-blocking/PLAUSIBLE; `"clean"` if none.
>
> **Return** the review schema: `{ issue, verdict, findings: [{ category, verdict, file, line, summary, failure_scenario }] }`. No Claude/AI mention anywhere.

### Retrospective (Opus, read-only)

> **Task:** You are the retrospective pass for this run — per-PR review sees one PR at a time; you see the run as a whole. Nothing downstream re-examines the merged surface — reason exhaustively across it. Since the last retrospective these PRs merged: `{MERGED_PRS}` (pairs of composite issue ref and PR number, `owner/repo#N (PR #M)`, possibly spanning repos — the PR number is what `gh pr diff` takes). The remaining DAG is `{REMAINING_NODES}` (refs + titles) with edges `{REMAINING_EDGES}`. Already filed by earlier retrospectives: `{FILED_REFS}`. Previously declined by the human — do **not** re-propose these or trivial variants: `{DECLINED}`. Do not write code, comment on issues, or modify anything — you propose; the human disposes.
>
> 1. Read each merged PR's diff against its own base: `gh pr diff {PR} --repo {OWNER/REPO}` and `gh pr view {PR} --repo {OWNER/REPO} --json title,body,files`. For the plan pass, read each remaining node's spec: `gh issue view {N} --repo {OWNER/REPO} --json title,body,labels`. Work from diffs; open files at the merged tip (sibling checkout under the org root) only where a diff alone is ambiguous. No worktrees, no checkouts of your own.
> 2. **Cross-PR pass:** over the union of the diffs, find what per-PR review structurally misses — near-duplicate logic landed by parallel implementers, the same problem solved two ways (pattern divergence), extract-helper/shared-module opportunities, duplicated test fixtures or setup. A cross-PR finding must cite **≥2 merged PRs** as evidence, at least one not itself a retro-filed ticket's PR (no refactors of refactors); a single-PR finding belongs to the review gate that already ran — drop it.
> 3. **Plan pass:** reread each remaining node's spec against what actually merged. Flag: a stale spec (merged code changed the ground it assumed — `respec`), a wrong or missing dependency (`add-edge` / `drop-edge`), an issue whose work already landed incidentally (`obsolete`), an issue the merged reality has made too big (`split`). Propose the smallest edit that makes the plan true again, with the evidence PR(s).
> 4. For each refactor: classify with the review vocabulary (`category` from the finding schema; confidence `CONFIRMED | PLAUSIBLE`), assign a `complexity` tier (`mechanical|normal|complex` — it sets implement effort if the ticket ships), name the `repo` the ticket belongs in (the run may span repos; the ticket's home is where its code lives, not where the run started), suggest `blockedBy`/`blocks` edges against remaining nodes where ordering matters — plus an edge naming a **merged** upstream in a *different* repo whose artifact the refactor consumes (it never blocks, but it routes the ticket through the cross-repo cutover gate) — and draft a ticket `body` to the `/file-ticket` bar: problem, desired end state, where (files/symbols from the evidence), acceptance criteria, evidence PRs as context links.
> 5. Rank refactors by expected payoff and keep the list short (≤5 typical) — a laundry list buries the two that matter. Anything real but not worth a ticket goes in `observations`. Nothing you return gates a merge; everything you saw already shipped.
>
> **Return** the retrospective schema (`references/retrospective-schema.md`): `{ mergedPrs, refactors[], planAdjustments[], observations[] }`. No Claude/AI mention anywhere.

---

## Model & effort

Per-step model and effort defaults, the complexity→effort mapping, and the "never crank effort on a weak model" / "escalate on failure per item" guardrails live in `references/model-effort-matrix.md`. Effort is actuated **literally** on the two primary paths — the engine (implement sessions: per-issue `model`/`effort`/`complexity` in the emitted config → `--model`/`--effort` on each session) and `workflow.js` (`agent(prompt, { effort })`, implement and review both); the inline `Agent` fan-out — the fallback, the engine-path review gate, and the retrospective always — approximates it via model choice + prompt framing.

## Telemetry

Every issue that reaches a terminal-for-this-wave state gets one JSON record — and every retrospective pass one run-scoped record — in an append-only run log, so leading indicators — Sonnet first-pass yield, triage-miss rate, review bounce/catch, HITL frequency, retro proposal/approval volume — are tracked across runs nearly for free.

**Emission is structural, not remembered.** The earlier design specified emission at five prose points, each an instruction to you with nothing enforcing it, and it under-emitted exactly when a run was long, multi-wave, and under context pressure — the runs whose data matters most. Records are now written as a *consequence* of commands the wave loop already runs:

| When | Command | What it writes |
|---|---|---|
| Run start | `node "$SD/scripts/telemetry.mjs" run-id [--label L]` | mints the run id (echoes an already-exported `SHIP_DAG_RUN_ID` unchanged) |
| Step 4a | `node "$SD/scripts/emit-config.mjs" spec.json` | `<stateDir>/ship-dag-wave.json` (run id, wave number, per-issue complexity + assigned model) **and** one HITL point-A record per `spec.deferred[]` entry |
| Step 6b | `node "$SD/scripts/telemetry.mjs" ingest-wave <report.json> --outcomes @outcomes.json` | one record per row of the engine's wave report — the whole wave in one call |
| Step 7 | `node "$SD/scripts/telemetry.mjs" audit [--base-dir D]` | nothing: it *reads*, and names every engine wave whose rows never reached the log |

- **Derived, never re-typed** — `ingest-wave` reads these off the engine's own artifacts (`<stateDir>/state/reports/<ISO>.json` joined to the step-4a sidecar, or `config.json` when there is no sidecar): `runId`, `repo`, `issue`, `complexity`, `triageStatus` (every issue in an engine config cleared triage by construction), `assignment`, `path`, `implStatus` (`succeeded`→`pushed`, `blocked`→`blocked`, else `error`), `ciStatus` (a `succeeded` row ran that repo's CI green pre-PR → `pass`; a failed row with a PR → `fail`; a failed row with none never reached CI → `null`), `pr`, and `ts` — stamped from the report's `finishedAt`, so a wave ingested (or backfilled) later lands at the time the work actually happened rather than at ingest time.
- **Agent judgement, supplied per issue** — nothing on disk records these, so the outcomes file is where they enter: `finalState` (required), `reviewVerdict`, `findings[]`, `bounces`, `hitl`, `failureReason`, `tokens`. Three shapes are accepted, cheapest first: `{"owner/repo#N": "merged"}`, `{"owner/repo#N": { "finalState": "merged", "reviewVerdict": "blocking", "bounces": 1 }}`, or `[{ "ref": "owner/repo#N", "finalState": "merged" }]`.
- **A half-supplied wave is refused, not half-written.** `ingest-wave` exits 2, names every ref you left out, and writes nothing; supply the rest and re-run. `--allow-missing` records only what you did supply, for the rare wave whose outcome genuinely can't be settled. Records are keyed on `runId + repo#issue + finalState + failureReason`, so re-running a close is a no-op rather than a doubling — and the rate-limit death record plus the later merge record for the same issue are two different keys and both survive.
- **Best-effort, always** — a telemetry failure must never abort a wave. `emit-config` warns on stderr and still emits its config if the sidecar or the point-A records can't be written; a batch with one invalid record drops that record with a warning and lands the rest; a refused `ingest-wave` is a prompt to fix the outcomes file, never a reason to stop the run.
- **What stays agent-driven, and why.** Three things have no artifact to derive from and remain yours: the step-6.5 `kind:"retro"` record (a run-scoped judgement about proposals a human just accepted or declined), the step-7 point-C deferral (the issue never entered a wave, so no report mentions it), and the fallback `workflow`/`inline` paths (no engine, hence no report — those still `append` one record at a time). Every wave the *engine* ran is recoverable regardless: its report is durable on disk, so `audit` finds the gap long after the fact and `ingest-wave` closes it.
- **Append** (single record — the fallback paths, the retro record, the point-C deferral, and the rate-limit death record): `node "$SD/scripts/telemetry.mjs" append '<json>'` (or `@file` / `-` for stdin). The record is validated and `ts`-stamped on write. Schema: `{ runId, repo, issue, complexity, triageStatus, assignment, path, implStatus, ciStatus, reviewVerdict, failureReason, findings[], bounces, hitl:{pointA,pointB}, finalState, pr, tokens }`; `implStatus`/`ciStatus`/`reviewVerdict` are `null` for issues that stop at triage. Records carry a `kind` discriminator — `"issue"` (the default; stamped when absent, so pre-existing logs stay valid) or `"retro"` (the step-6.5 pass record — a different shape, validated separately and excluded from every per-issue indicator; see `scripts/telemetry.mjs`).
- **`failureReason`** is `null` except alongside `implStatus: "error"` for a rate-limit death, where it's `"rate-limited"` (see step 5 and `references/escalation-policy.md`'s point-E recovery recipe) — a distinguishable marker `report()` uses to separate quota failures from model failures: `"rate-limited"` records are excluded from the model-quality indicators (first-pass yield, triage-miss, bounce rate) and tallied instead in the report's `quotaFailures` count (`renderReport()` prints a `quota failures:` line whenever it's non-zero), so a quota outage never makes those numbers look worse than the model actually performed.
- **`path`** records `"engine"` (primary — implement via the orchestrator, review from the skill), `"workflow"`, or `"inline"` (the two fallbacks). Effort is actuated literally on `engine` (implement sessions) and `workflow`; the `engine` path's review gate and the whole inline `Agent` fan-out are *nominal* (prompt-approximated — the `Agent` tool has no `effort` param), so the report never treats inline effort as actuated.
- **`tokens`** is `null` on the inline path (per-agent token counts aren't exposed to the orchestrator); real cost attribution lives in the eval harness, not here.
- **Report:** `node "$SD/scripts/telemetry.mjs" report [--since ISO]` prints the indicators (JSON to stdout, table to stderr), broken down by complexity tier.
- **Audit:** `node "$SD/scripts/telemetry.mjs" audit` prints, per engine wave report on disk, how many of its rows reached the log — `missing` (no record anywhere) and `elsewhere` (recorded under a different run id, so the datum survived but per-run grouping lost it). Run ids are folded for matching only (`ship-dag-` prefixes and `-w2`/`-r2`/`-resume` state-dir suffixes are stripped), never rewritten in the log.
- **Storage:** append-only JSONL *outside* the repo — `$SHIP_DAG_TELEMETRY`, else `$XDG_STATE_HOME/ship-dag/runs.jsonl`, else `~/.local/state/ship-dag/runs.jsonl` — so collected run data can never be accidentally committed. The log is collected data: never truncate, reorder, or rewrite it, and point `$SHIP_DAG_TELEMETRY` at a scratch file for anything experimental.
- **Tests:** `node --test "skills/ship-dag/scripts/**/*.test.mjs"`.

## Guardrails (non-negotiable)

- **Anonymity** — no Claude/Claude Code attribution in commits, PRs, issue comments, anywhere. Ghost-writer mode.
- **Worktree per issue** — created before any code; removed via `/cleanup` after merge.
- **CI before push** — local lint/format/typecheck/tests must pass before any push.
- **No auto-retry loops** — ≤2 manual retries on infra failure, then stop and report cost.
- **Data safety** — never reset/overwrite collected data; surgical changes only. The run log is collected data: append only, never truncate or rewrite it, and point `$SHIP_DAG_TELEMETRY` at a scratch file for anything experimental.
- **Telemetry is structural and best-effort** — records come out of commands the loop already runs (step 4a's `emit-config`, step 6b's `ingest-wave`), a half-supplied wave is refused rather than half-written, and no telemetry failure may ever abort a wave (step 6b, *Telemetry*).
- **Cross-repo cutover is a HITL gate** — never auto-release a wave whose readiness depends on a *different* repo's merge; confirm the upstream is published/deployed/consumable (or a gate command passed) first. "Satisfied" ≠ "merged" across a repo boundary (step 7, point C).
- **The retrospective proposes; it never disposes** — no ticket filed, edge written, spec edited, or issue closed without point-D approval, and it never touches merged code (step 6.5).
- **Auto-merge is a deliberate, requester-authorized deviation** from the house "never auto-merge" rule (`cross-repo-migration`). It is kept tightly behind the green gate (CI pass + no CONFIRMED blocking finding + no open questions), serialized in dependency order, and re-gated after any base-moving rebase. `--dry-run` and the five HITL points (A triage, B implement/review, C cross-repo cutover, D retrospective, E rate-limit window) are the escape hatches.

## Reused building blocks

`/recheck-issues` (DAG re-sync), `/review-loop` (fix blocking findings), `/cleanup` (post-merge tidy), the built-in `/code-review` (optional review augmentation), `/file-ticket` (follow-ups discovered mid-run, and the step-6.5 retrospective's approved refactor tickets — its one structured caller). `AskUserQuestion` for crisp HITL forks. All PR/issue refs passed to these are fully-qualified `owner/repo#N`.

**Engine-invocation bundle (step 4):** `scripts/emit-config.mjs` (ready-wave spec → engine config JSON; tested), `scripts/engine/run.mts` + `hooks.mts` + `prompt.md` (the config bundle the engine loads — `run.mts` registers the config under key `wave` and calls `createMain`; `hooks.mts` wires `deriveWorktreeHooks` + the cutover backstop), and `references/repo-ci-profiles.json` (per-repo base branch + CI). All import the engine from `$CO_HOME/dist` — the same checkout `plan-waves.mjs` uses; keep `CO_HOME` consistent across both.

**Telemetry bundle (run start / steps 3, 4a, 6b, 7):** `scripts/telemetry.mjs` (the CLI — `run-id`, `append`, `ingest-wave`, `audit`, `report`; the log I/O and the indicator math) and `scripts/lib/wave-records.mjs` (pure — run-id minting/folding, and the join that turns an engine wave report plus its config/sidecar into telemetry records; tested). `scripts/emit-config.mjs` writes the wave sidecar and the point-A defer records as a side effect of building the engine config.

**Rate-limit preflight + failure classification (step 4/5):** `scripts/rate-limit-preflight.mjs` (CLI — finds the newest engine session transcript under the well-known `ship-dag/engine/<runId>/state/logs/` base dir and prints the wait/proceed/hitl decision; tested) and `scripts/lib/rate-limit.mjs` (pure — transcript parsing, the preflight decision math, and `classifyFailureReason` for step 5's rate-limited-vs-model-failure routing; tested).
