# ship-dag

[![tests](https://github.com/jakebromberg/ship-dag/actions/workflows/tests.yml/badge.svg)](https://github.com/jakebromberg/ship-dag/actions/workflows/tests.yml)

A [Claude Code](https://claude.com/claude-code) skill that ships a dependency DAG of already-filed GitHub issues to `main`, **one wave at a time**. Each issue flows through the cheapest capable subagent — Haiku triage, Sonnet implement, Opus review — and lands via rebase-and-merge, **auto-merged on green**. The main agent owns everything human-facing and stateful (DAG discovery, the ready-set, the HITL gates, the dependency-ordered merge queue); the expensive parallel implement→review work fans out to subagents.

The premise: a well-specced issue Sonnet-implements and survives the Opus gate cleanly. When that premise breaks — an ambiguous spec, a blocking finding, a CI/merge failure — that break is the signal to stop and grill the human.

Between the merge queue and the next wave, a **retrospective pass** (one read-only Opus subagent) reviews the merged surface holistically — the cross-PR duplication that per-PR review structurally misses, and remaining-plan drift — and, after human approval (HITL point D), files ghost-written refactor tickets into the remaining DAG and applies plan adjustments.

See [`SKILL.md`](./SKILL.md) for the full skill definition and the wave loop.

## Dependency: claude-orchestrator

The parallel **implement** fan-out is delegated to the [claude-orchestrator](https://github.com/jakebromberg/claude-orchestrator) engine — per-repo worktrees + CI, per-issue model/effort, `mergePolicy: "none"` (implement, run CI, open a PR, then STOP; the Opus review gate and merge queue stay in the skill). Point `CO_HOME` at a checkout of that repo (default `~/Developer/claude-orchestrator`); its `dist/` must be built (`npm run build` — `dist/` is committed, so a fresh clone already has it).

## Project resolution (org-agnostic)

ship-dag resolves the target project from context, never assuming an org:

- **Repo** — a fully-qualified `owner/repo#N` wins; else inferred from the cwd (`gh repo view`); else `--org O` with a bare `repo`.
- **Org checkout root** (where per-repo worktrees are created) — derived from the resolved repo's checkout, i.e. the parent of `git rev-parse --show-toplevel`. Override with `SHIP_DAG_REPOS_DIR` (or `SHIP_DAG_PROJECT_ROOT`, which the skill already emits).
- **Per-repo base branch + local CI** — from [`references/repo-ci-profiles.json`](./references/repo-ci-profiles.json), keyed by `owner/repo`. A repo absent there defaults to `main` with no post-session check (the emitter warns — an unverified wave is the dangerous failure mode).

## Install as a Claude Code skill

Clone and symlink into your skills directory:

```bash
git clone git@github.com:jakebromberg/ship-dag.git ~/Developer/ship-dag
ln -s ~/Developer/ship-dag ~/.claude/skills/ship-dag
```

## Tests

```bash
node --test 'scripts/**/*.test.mjs' 'eval/**/*.test.mjs'
```

The suite loads the topo-sort core, so `CO_HOME` must point at a checkout of [claude-orchestrator](https://github.com/jakebromberg/claude-orchestrator) with its deps installed (`npm ci` there — `dist/` is committed, no build). CI ([`.github/workflows/tests.yml`](./.github/workflows/tests.yml)) does exactly this on every push and PR, across Node 22 and 24.

## Layout

| Path | What |
|------|------|
| `SKILL.md` | The skill definition — arguments, the wave loop, HITL gates. |
| `scripts/plan-waves.mjs` | DAG fetch + wave planning (imports claude-orchestrator's topo-sort core). |
| `scripts/emit-config.mjs` | Turns a cleared ready-wave into a claude-orchestrator engine config. |
| `scripts/engine/` | The engine-invocation path: `run.mts` (entry), `hooks.mts` (worktree + cutover), `repos-dir.mjs` (org-root resolution), `prompt.md`. |
| `references/tuning.json` | Versioned effort policy (review floor, reach→effort, implement map); `scripts/lib/tuning.mjs` loads, validates and resolves it. |
| `scripts/telemetry.mjs` | Per-issue + per-retro-pass run records (model-assignment efficacy). The `ingest-wave` subcommand (`ingestWave`) appends a wave's records derived from its engine report, sidecar entry (else matching config), failure digests and review rounds, plus `--outcomes`, each that reached implement with the `cost.implement` read from its ref's transcript. The `escapes` subcommand reports the escaped-defect proxy (see `scripts/lib/escapes.mjs`). |
| `scripts/lib/wave-sidecar.mjs` | Append-only `ship-dag-wave.jsonl` sidecar (one line per wave): `waveSidecar` (built from the config `buildConfig` returned), `appendWave`, `waveContextMatches`, `findWaveContext`, and, for a wave emitted before the sidecar, `findWaveConfig` (the newest `config*.json` by mtime matching a ref set) and `entryFromConfig` (the sidecar-shaped entry built from it). Both finders take an optional cutoff, so a later re-emit of the same ref set is not taken for an earlier report's routing. |
| `scripts/lib/run-id.mjs` | Run-id helpers: `mintRunId`, `canonicalRunId`, `runIdFromConfigName`, and `sameRun` (folds wave/retry suffixes, prefix, case). |
| `scripts/lib/review-rounds.mjs` | The one review-round matcher: `reviewRoundFiles` (a ref's round files across `reviews/` dirs, legacy `-rN`/`.iterN`/`.passN*` tags included, oldest first by mtime) and `isUnreadableEmpty` (the empty-beside-`.raw` signature). |
| `scripts/lib/wave-records.mjs` | `deriveWaveRecords`: a wave's telemetry issue records from its report, sidecar entry, failure digests, review rounds and `--outcomes` (worst verdict and its blocking findings, bounces, routing, `ciStatus`, `reportId`, dedupe by `sameRun`, and by `reportId` only between PR-less failures; findings as `<category> <file>:<line> <summary>` strings; a rate-limit death is `deferred`; a half-supplied refusal names every ref under each cause). |
| `scripts/lib/transcript-cost.mjs` | `implementCost`: a ref's implement cost streamed from its stream-json transcript, over the sessions that wrote a result record and that no earlier record of the run family lists, each counted once (its last running `total_cost_usd`, its `usage` summed). |
| `scripts/lib/escapes.mjs` | The escaped-defect proxy behind `telemetry.mjs escapes`: `shipDagPrs` (the population: merged telemetry `pr` fields, engine report rows' `prNumber`, and, for a sidecar ref with neither, its one merged `orchestrator/` closing PR), `findEscapes` (per PR whose 30-day window has closed, the reverts and bug-signalled follow-ups citing it, from per-repo per-merge-day candidate searches cached under `$SHIP_DAG_ESCAPES_DIR` once the day's window closes, with bounded rate-limit backoff), `cites`, and `escapeReport` (rates by merge month and `tuningVersion`). |
| `references/` | CI profiles, model/effort matrix, escalation policy, review + retrospective + eval schemas. |
| `eval/` | Offline eval harness for the model-assignment study. |
| `docs/` | [Field report](./docs/field-report.md) from the first production run, plus a runnable anonymized [telemetry sample](./docs/examples/run-sample.jsonl). |
