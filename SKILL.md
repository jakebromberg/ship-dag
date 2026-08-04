---
name: ship-dag
description: Ship a dependency DAG of GitHub issues to main — per-issue subagents (Haiku triage, Sonnet implement, Opus review), auto-merge on green (rebase-and-merge), and HITL grilling on any open question. Use when the user wants to autonomously work through an epic or a set of dependent issues end to end.
argument-hint: "[epic#N | --label L | org/repo#N ...] [--org O] [--block-on correctness,security] [--max-review-iter 2] [--workflow-threshold 5] [--dry-run]"
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
- `--dry-run` — print the full wave partition (`waves` / `blocked` / `cyclic`) and the per-issue model/effort assignment, then stop **before any side effect**.

## The wave loop

`SD=$HOME/.claude/skills/ship-dag`. Repeat until the DAG is drained or everything left is blocked on a HITL decision:

### 1. Discover / refresh the DAG

- Run `/recheck-issues` on the issue set first, so state moved by peers/humans since you last looked is picked up.
- **The graph math is delegated, not reimplemented.** `plan-waves.mjs` imports the shared composite-keyed topological-sort core (`readySet`/`layeredTopoSort`) from claude-orchestrator's built `dist/`, so this planner and the engine's `computeWaves` can't drift. Point `CO_HOME` at that checkout if it isn't the default `/Users/me/Developer/claude-orchestrator`; the core must be built there (`npm run build` — `dist/` is committed, so a fresh clone already has it). If the import fails, the script errors with exactly that instruction.
- Build the spec into a temp file. **Single repo:** `SPEC=$(mktemp); node "$SD/scripts/plan-waves.mjs" fetch --repo owner/repo (--epic N | --label L) > "$SPEC"` (or pipe `fetch … | … plan -`). It emits `{ repo, nodes[], edges[], done[] }` keyed on **composite refs**: each node carries `{ number, repo, ref, bodyLen, refCount, labels }` (the last three feed the triage-effort decision), edges are `{ blocked, blockedBy }` ref pairs, and `done[]` holds refs. Sub-issues come from GraphQL `subIssues` (paginated, each keyed on its **own** `repository.nameWithOwner` — a cross-repo sub-issue stays in its home repo, not the epic's). The `--epic` walk is **recursive**: a sub-issue that is itself an epic is descended into, to any depth, in its own repo. Only the leaves become nodes — an intermediate epic is a grouping, not a unit of work, and shipping it would hand a whole sub-tree to one implement subagent. `subIssuesSummary.total` rides along in the parent's response, so a leaf costs no query of its own; a CLOSED sub-issue takes its whole sub-tree out of scope; a cyclic hierarchy terminates with a warning; and an epic whose own sub-issue query comes back unreadable is kept as a single node rather than silently dropped. **An open epic whose descendants are all closed ships as a node** — it isn't a grouping of pending work, it *is* the pending work. Edges are fetched automatically from **two** sources and merged: GitHub's native issue-dependency graph (each node's `blocked_by` list, via `gh api .../dependencies/blocked_by` — tolerant of a repo where it isn't configured or isn't visible to the token) and body-prose `Blocked by #N` / `Blocks #N` / `Depends on #N`, including both the adjacent-clause form ("Blocked by #12, #13 and #14", multi-issue **and** cross-repo `owner/repo#N` refs handled) and a `## Blocked by` / `## Depends on` heading followed by a bulleted list of refs; a bare `#N` is qualified to the citing issue's repo either way. On an `--epic` fetch, edges naming an epic are then rewritten — **before** the merged set is deduped on the `{blocked, blockedBy}` pair, since the rewrite itself can produce the same pair twice on top of the duplicates the two sources already contribute. The rewrite is needed because an epic never ships and so an edge left pointing at one could never be satisfied (it stays open until its last child closes) — stranding its dependent as permanently blocked: an edge between an issue and one of its **own ancestor epics** is containment ("this is part of that", which the native dependency graph surfaces as a `blocked_by` entry), so it is dropped in both directions; every other epic edge is **expanded onto the leaves** — "X is blocked by epic E" becomes "X is blocked by every leaf of E", and an epic's own blocker is pushed down onto each leaf that ships in its place. Closed/merged dependencies are resolved into `done[]`, each viewed in **its own** repo.
- **Multi-repo issue set** (an explicit `org/repo#12 other/repo#15 …` set, or a cross-repo epic): `fetch` takes one `--repo` per call, so fetch once per distinct repo (by `--epic`/`--label`, or hand-build the `nodes[]` for an explicit set) and **union** the results — concatenate `nodes[]`, `edges[]`, `done[]` into one spec, keeping a single top-level `repo` as the default for any still-bare ref. Unioning is safe precisely because every endpoint is a composite ref: same-numbered issues in different repos stay distinct and cross-repo edges survive. (The epic path already unions cross-repo sub-issues for you.)
- A dependency counts as satisfied when its issue is **merged or closed** (fetch already folds those into `done[]`) — but see step 7: a *cross-repo* dependency's merge is not enough to auto-release its downstream.

### 2. Compute the ready-set

- `node "$SD/scripts/plan-waves.mjs" plan "$SPEC"` → `{ waves, blocked, cyclic }` (entries are composite refs — `owner/repo#N`, or a bare `N` in a single-repo DAG).
- `waves[0]` is the current ready-set. If `cyclic` is non-empty or `blocked` lists external blockers while nothing is ready, **stop and report** — the DAG can't advance without human input.
- On `--dry-run`: print `waves`, the `blocked`/`cyclic` report, and the model/effort each issue would get (per `references/model-effort-matrix.md`); then stop.

### 3. Triage gate — HITL point A

Fan out **one `Agent{model:"haiku"}` per ready issue, all in a single message** (read-only; see the Triage block). Each returns `{ clear | needs-decision, complexity, questions[], digest }`.

- Collect every `needs-decision` across the wave and **grill the user once** (batch, not per-issue) — `AskUserQuestion` for crisp forks, inline interview for open design questions (`references/escalation-policy.md`). Record each resolution as a GitHub issue comment (ghost-writer, no attribution); update the issue body if scope changed.
- Only **cleared** issues proceed. Carry each issue's `complexity` → implement effort and `digest` forward.
- **Telemetry:** emit one record (see *Telemetry* below) for every issue **deferred at this gate** — `finalState:"blocked-hitl"`, `hitl.pointA:true`, `implStatus`/`ciStatus`/`reviewVerdict` null. These point-A records are what make the triage-miss and HITL-A indicators measurable instead of survivor-only.

### 4. Implement fan-out — the engine implements, the skill reviews

The parallel **implement** work is delegated to the **claude-orchestrator engine** — per-repo worktrees + CI, per-issue model/effort, and its default `mergePolicy: "none"` (implement each issue in its own worktree, run that repo's CI, open a PR, then **STOP** — never merge). The **Opus review gate stays here**, as a ship-dag pass over the PRs the engine opens. `CO_HOME` points at the engine checkout (default `/Users/me/Developer/claude-orchestrator`, the same core import as step 1).

**a. Emit the engine config.** Build a ready-wave spec (JSON): for each **cleared** issue `{ number, repo, ref, title, complexity, model?, effort?, digest, extraDirs? }` — carry triage's `complexity` (the engine derives effort from it); set `model`/`effort` only where triage or the rubric overrides. Add `repos` from `references/repo-ci-profiles.json` for the wave's distinct repos (each `{ baseBranch, commands }`; a repo absent there defaults to `main` + no CI — emit-config warns); `name: "ship-dag-<runId>"`; an absolute per-run `stateDir` **outside any repo** (e.g. `${XDG_STATE_HOME:-$HOME/.local/state}/ship-dag/engine/<runId>`); `projectRoot` = the org checkout root `$PROJECT_ROOT`, derived once as `PROJECT_ROOT="${SHIP_DAG_REPOS_DIR:-$(dirname "$(git rev-parse --show-toplevel)")}"` — the parent of the target repo's checkout in the sibling layout; set `SHIP_DAG_REPOS_DIR` to override (e.g. a meta-repo root like `/Users/me/Developer/daisyguide`); `promptTemplate` = `$SD/scripts/engine/prompt.md`. Then:
`node "$SD/scripts/emit-config.mjs" spec.json > "$STATE/config.json"`. Every ready-wave issue is independent, so emit-config gives each `dependsOn: []` — one flat wave the engine runs fully in parallel.

**b. Invoke the engine.** Export `CO=${CO_HOME:-/Users/me/Developer/claude-orchestrator}` once. Preview first (read-only, no side effects — the analog of `--dry-run`):
`SHIP_DAG_CONFIG="$STATE/config.json" CO_HOME="$CO" npx --prefix "$CO" tsx "$SD/scripts/engine/run.mts" wave --plan`
then run it:
`SHIP_DAG_CONFIG="$STATE/config.json" SHIP_DAG_PROJECT_ROOT="$PROJECT_ROOT" CO_HOME="$CO" npx --prefix "$CO" tsx "$SD/scripts/engine/run.mts" wave --parallel K`.
`SHIP_DAG_PROJECT_ROOT` also feeds the worktree layer's repos dir (via `reposDirFromEnv`'s fallback in `hooks.mts`), so this single env var keeps both the `--detach` respawn root and the per-repo worktrees under `$PROJECT_ROOT` — no WXYC path is assumed. Export `SHIP_DAG_REPOS_DIR` explicitly only if the two must differ.

**c. Read the report.** The engine writes `<stateDir>/state/reports/<id>.json`. Each row is keyed on the composite **`ref`** (`owner/repo#N`) — the disambiguator for same-numbered cross-repo issues — plus `number`, `status`, `prUrl`, `prNumber`. A `succeeded` row means the engine ran that repo's CI green before opening the PR (`retryOnCheckFailure` retried once, else the row is `failed`), so treat it as `ciStatus: "pass"` and map its `ref`→`prNumber` (branch via `gh pr view <PR> --json headRefName` if the review needs it). A `failed`/`blocked` row (no PR) is an implement stall → **HITL point B** (step 5).

**d. Review pass (Opus — stays in the skill).** For each opened PR, run the **Review** subagent (the verbatim block below) over the PR's diff against **its own** base branch → `{ verdict, findings[] }`. This yields the same per-issue result the fallback paths do — `{ issue, ref, branch, pr, ciStatus, review:{ verdict, findings[] }, openQuestions[] }` — which step 5 reconciles.

**Fallback (engine unavailable — `CO_HOME` unset/unbuilt, or the invocation errors):** revert to the pre-C1 path. Cleared count ≥ `--workflow-threshold` **and** `Workflow` available → `Workflow({ scriptPath: "$SD/workflow.js", args: { repo, blockOn, issues: [{ number, digest, complexity, implEffort, reviewEffort }] } })`; else inline `Agent` fan-out (one Implement per issue in a single message, Review each as it returns). Both blocks are still present and produce the same result shape. The engine is preferred: it actuates per-issue effort literally, isolates per-repo worktrees + CI, and survives `--detach` — the fallback keeps ship-dag working without the engine checkout.

**Mixed-repo waves:** the engine handles them natively (per-issue `repo` → per-repo worktree, base branch, and CI), where `workflow.js` takes a single `repo` per batch. In practice a single ready wave rarely mixes repos, since cross-repo edges fall on wave boundaries where step 7's point-C gate already stops you.

### 5. Reconcile each result

- **Green** — CI pass, review `verdict` not `blocking`, no open questions → queue for merge.
- **Blocking finding** → `/review-loop owner/repo#PR --max-iter K` (from *you*, the main agent — reliable Skill access). Converges to green → queue. Doesn't clear within `--max-review-iter`, or needs a design call → **HITL point B**. On a bounce, the retried implement runs one effort tier higher (rubric guardrail 2).
- **Open question surfaced mid-implementation / non-flaky CI failure / judgment-needing merge conflict** → **HITL point B** (grill), then re-queue or defer the issue.
- **Telemetry:** emit one record for every issue that **terminates here** without merging (`blocked-hitl` / `deferred` / `error`), capturing `implStatus`, `ciStatus`, `reviewVerdict`, `findings[]`, `bounces`, and `hitl.pointB`.

### 6. Merge queue — auto on green

Side-effecting; all on you, the main agent; serialized in **dependency order**. Per queued PR:

1. `git fetch`; rebase the PR branch onto the latest tip of **its own repo's base branch** — not a hardcoded `main`. Resolve it per repo (`gh repo view owner/repo --json defaultBranchRef -q .defaultBranchRef.name`, or `git rev-parse --abbrev-ref origin/HEAD`); e.g. `wxyc-ios-64` is `master`.
2. **If the rebase moved the base** (a sibling from this wave already merged under it — the normal dependent-wave case): **re-run BOTH local CI and the Opus review gate** and re-check `--block-on` before merging. A verdict computed pre-rebase does not carry over once the base changed. If the re-gate now finds a blocking issue, pull the PR back into step 5.
3. `gh pr merge --rebase`.
4. `/cleanup owner/repo#PR` — remove the worktree, delete the branch, fast-forward, prune.
5. **Telemetry:** emit one record (`finalState:"merged"`, plus the **worst** `reviewVerdict` seen for the issue — a bounced-then-merged issue logs `blocking`, not the post-fix `clean`, so triage-miss and review-catch stay measurable rather than survivor-biased — `bounces`, and `path`) for the merged issue — see *Telemetry* below.

**Never loop-retry a failing CI or merge.** ≤2 manual retries on an infra failure, then stop and surface the failure + cost. No `while`-loops against a red run.

### 7. Advance — HITL point C on any cross-repo cutover

Mark merged issues done; go to step 1. The re-fetched `done[]` will surface the next wave.

**Cross-repo cutover gate — "satisfied" ≠ "merged" across a repo boundary.** A merged upstream PR is not consumable downstream until it is published/deployed (e.g. `wxyc-shared` → GH Packages → `Backend-Service`; a BS deploy → the canary validates it live). So when a newly-ready issue becomes ready **because a dependency in a *different* repo just merged**, do **not** auto-release it — **stop and grill the human** to confirm the upstream artifact is actually consumable (package published, service deployed, migration cut over), or that a named gate command succeeded, before triaging/implementing that dependent. Same-repo edges keep releasing automatically; only an edge crossing a repo boundary (or into a manual deploy/publish step) gates here. This mirrors the "anything irreversible outside the merge itself → ship it by hand" rule. A deferral here emits a `blocked-hitl` telemetry record, as at point B.

Stop when `waves` is empty (drained) or the only remaining issues are blocked on a HITL decision you've already surfaced.

At the end, print a **wave summary**: per issue — final state (`merged` / `blocked-hitl` / `deferred` / `error`), PR number, review verdict, and any nits or routed findings for the human.

---

## Subagent instruction blocks

Include the relevant block **verbatim** in each subagent's prompt (the inline fallback path). The **Implement** block has two other copies — `scripts/engine/prompt.md` (the engine's template, the primary path) and `workflow.js` (the accelerator fallback); the **Review** block is mirrored in `workflow.js`. Keep all copies in sync when editing. The Review block runs from the skill on every path (the engine implements only), so it is the one block that is never skipped.

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
> 1. Locate the repo checkout (sibling under `/Users/me/Developer/`, else `gh repo clone`). `cd` in. Read repo + package `CLAUDE.md` and the patterns in the module you're touching; match them.
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

---

## Model & effort

Per-step model and effort defaults, the complexity→effort mapping, and the "never crank effort on a weak model" / "escalate on failure per item" guardrails live in `references/model-effort-matrix.md`. Effort is actuated **literally** on the two primary paths — the engine (per-issue `model`/`effort`/`complexity` in the emitted config → `--model`/`--effort` on each session) and `workflow.js` (`agent(prompt, { effort })`); only the inline fallback approximates it via model choice + prompt framing.

## Telemetry

Every issue that reaches a terminal-for-this-wave state emits one JSON record to an append-only run log, so leading indicators — Sonnet first-pass yield, triage-miss rate, review bounce/catch, HITL frequency — are tracked across runs nearly for free. Emission is wired at the three points terminals actually occur (**step 3** point-A defer, **step 5** blocked/deferred/error, **step 6** merged), not batched at the end.

- **Append** (best-effort — a telemetry failure must never abort a wave): `node "$SD/scripts/telemetry.mjs" append '<json>'` (or `@file` / `-` for stdin). The record is validated and `ts`-stamped on write. Schema: `{ runId, repo, issue, complexity, triageStatus, assignment, path, implStatus, ciStatus, reviewVerdict, findings[], bounces, hitl:{pointA,pointB}, finalState, pr, tokens }`; `implStatus`/`ciStatus`/`reviewVerdict` are `null` for issues that stop at triage. Mint one `runId` per `/ship-dag` invocation.
- **`path`** records `"engine"` (primary — implement via the orchestrator, review from the skill), `"workflow"`, or `"inline"` (the two fallbacks). Effort is actuated literally on `engine` and `workflow`; on the inline `Agent` fan-out it is *nominal* (prompt-approximated — the `Agent` tool has no `effort` param), so the report never treats inline effort as actuated.
- **`tokens`** is `null` on the inline path (per-agent token counts aren't exposed to the orchestrator); real cost attribution lives in the eval harness, not here.
- **Report:** `node "$SD/scripts/telemetry.mjs" report [--since ISO]` prints the indicators (JSON to stdout, table to stderr), broken down by complexity tier.
- **Storage:** append-only JSONL *outside* the repo — `$SHIP_DAG_TELEMETRY`, else `$XDG_STATE_HOME/ship-dag/runs.jsonl`, else `~/.local/state/ship-dag/runs.jsonl` — so collected run data can never be accidentally committed.
- **Tests:** `node --test "skills/ship-dag/scripts/**/*.test.mjs"`.

## Guardrails (non-negotiable)

- **Anonymity** — no Claude/Claude Code attribution in commits, PRs, issue comments, anywhere. Ghost-writer mode.
- **Worktree per issue** — created before any code; removed via `/cleanup` after merge.
- **CI before push** — local lint/format/typecheck/tests must pass before any push.
- **No auto-retry loops** — ≤2 manual retries on infra failure, then stop and report cost.
- **Data safety** — never reset/overwrite collected data; surgical changes only.
- **Cross-repo cutover is a HITL gate** — never auto-release a wave whose readiness depends on a *different* repo's merge; confirm the upstream is published/deployed/consumable (or a gate command passed) first. "Satisfied" ≠ "merged" across a repo boundary (step 7, point C).
- **Auto-merge is a deliberate, requester-authorized deviation** from the house "never auto-merge" rule (`cross-repo-migration`). It is kept tightly behind the green gate (CI pass + no CONFIRMED blocking finding + no open questions), serialized in dependency order, and re-gated after any base-moving rebase. `--dry-run` and the three HITL points (A triage, B implement/review, C cross-repo cutover) are the escape hatches.

## Reused building blocks

`/recheck-issues` (DAG re-sync), `/review-loop` (fix blocking findings), `/cleanup` (post-merge tidy), the built-in `/code-review` (optional review augmentation), `/file-ticket` (only if a follow-up ticket is discovered mid-run). `AskUserQuestion` for crisp HITL forks. All PR/issue refs passed to these are fully-qualified `owner/repo#N`.

**Engine-invocation bundle (step 4):** `scripts/emit-config.mjs` (ready-wave spec → engine config JSON; tested), `scripts/engine/run.mts` + `hooks.mts` + `prompt.md` (the config bundle the engine loads — `run.mts` registers the config under key `wave` and calls `createMain`; `hooks.mts` wires `deriveWorktreeHooks` + the cutover backstop), and `references/repo-ci-profiles.json` (per-repo base branch + CI). All import the engine from `$CO_HOME/dist` — the same checkout `plan-waves.mjs` uses; keep `CO_HOME` consistent across both.
