# ship-dag

[![tests](https://github.com/jakebromberg/ship-dag/actions/workflows/tests.yml/badge.svg)](https://github.com/jakebromberg/ship-dag/actions/workflows/tests.yml)

A [Claude Code](https://claude.com/claude-code) skill that ships a dependency DAG of already-filed GitHub issues to `main`, **one wave at a time**. Each issue flows through the cheapest capable subagent — Haiku triage, Sonnet implement, Opus review — and lands via rebase-and-merge, **auto-merged on green**. The main agent owns everything human-facing and stateful (DAG discovery, the ready-set, the HITL gates, the dependency-ordered merge queue); the expensive parallel implement→review work fans out to subagents.

The premise: a well-specced issue Sonnet-implements and survives the Opus gate cleanly. When that premise breaks — an ambiguous spec, a blocking finding, a CI/merge failure — that break is the signal to stop and grill the human.

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
| `scripts/telemetry.mjs` | Per-issue run records (model-assignment efficacy). |
| `references/` | CI profiles, model/effort matrix, escalation policy, review + eval schemas. |
| `eval/` | Offline eval harness for the model-assignment study. |
