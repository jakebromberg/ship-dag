#!/usr/bin/env node
// emit-config.mjs — turn a triaged ready-wave spec into a claude-orchestrator
// config (Phase C / C1 of the cross-repo plan).
//
// /ship-dag's step 4 no longer fans out implement sessions itself. It hands the
// cleared ready-wave to the claude-orchestrator engine (per-repo worktrees +
// CI, per-issue model/effort, `mergePolicy: "none"` = implement + open PR +
// STOP). This script builds the config the engine loads; the Opus review gate
// and the dependency-ordered merge queue stay in the skill (steps 5–6).
//
// Why a script (not LLM-authored YAML): the mapping has load-bearing invariants
// the model must not improvise — every ready-wave issue is independent, so each
// gets `dependsOn: []` (one flat wave the engine runs fully in parallel); the
// `repos:` map must contain exactly the repos the issues reference (the engine's
// `unknownRepoKeys` throws on any extra key); descriptions carry arbitrary triage
// prose that must round-trip safely.
//
// Output is JSON. JSON is a subset of YAML, so the engine's `yaml` parser reads
// it verbatim — this keeps the emitter dependency-free (no YAML stringifier) and
// escaping-safe (JSON.stringify handles quotes/newlines in digests).
//
// Spec shape (JSON):
//   {
//     "name":           "ship-dag-<runId>",        // engine config name
//     "repo":           "owner/repo",              // default repo for repo-less issues
//     "stateDir":       "/abs/per-run/dir",        // configDir + worktreeDir live under here (outside any repo)
//     "projectRoot":    "/abs/org/checkout/root",  // the --detach respawn + relative paths resolve from here
//     "promptTemplate": "/abs/engine/prompt.md",   // the implement prompt
//     "stallTimeout":   1800,                       // optional (default 1800)
//     "defaultModel":   "sonnet",                   // optional (default sonnet)
//     "retryMaxRetries":1,                          // optional (default 1)
//     "repos": {                                    // per-repo base branch + CI profile
//       "owner/repo": { "baseBranch": "main", "commands": ["ruff check .", "pytest -q"] }
//     },
//     "issues": [
//       { "number": 924, "repo": "owner/repo", "title": "...", "complexity": "normal",
//         "model": "opus", "effort": "high", "digest": "2-3 sentence plan", "extraDirs": ["../wxyc-shared"] }
//     ]
//   }
//
// Usage:
//   node emit-config.mjs <spec.json|->            # read spec (stdin with -), write config JSON to stdout
//   node emit-config.mjs <spec.json> > config.json

import { readFileSync } from 'node:fs';
import { isMain } from './lib/is-main.mjs';

/**
 * A filename/branch-safe slug from an issue title, or `issue-<number>` when the
 * title yields nothing usable. Lowercase, non-alphanumerics collapsed to single
 * dashes, trimmed, capped at 50 chars with no trailing dash.
 */
export function deriveSlug(number, title) {
  const base = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return base || `issue-${number}`;
}

/** The repo an issue belongs to (its own `repo`, else the spec default). */
function repoOfIssue(issue, spec) {
  return issue.repo || spec.repo;
}

/**
 * The distinct set of repos the wave's issues reference, in first-seen order.
 * The `repos:` map is built from exactly these — never a superset — because the
 * engine's `unknownRepoKeys` throws on any key no issue (or defaultRepo) uses.
 */
function distinctRepos(spec) {
  const seen = [];
  for (const issue of spec.issues) {
    const r = repoOfIssue(issue, spec);
    if (r && !seen.includes(r)) seen.push(r);
  }
  return seen;
}

/**
 * Issue repos that have no CI profile in `spec.repos` (or a profile with no
 * commands). Those repos will run with no post-session check — the caller should
 * surface this rather than let a wave land unverified silently.
 */
export function unknownCiRepos(spec) {
  return distinctRepos(spec).filter((r) => {
    const profile = spec.repos?.[r];
    return !profile || !profile.commands || profile.commands.length === 0;
  });
}

/** Build the engine config object from a ready-wave spec. */
export function buildConfig(spec) {
  const repos = {};
  for (const r of distinctRepos(spec)) {
    const profile = spec.repos?.[r] ?? {};
    const entry = { baseBranch: profile.baseBranch || 'main' };
    if (profile.commands && profile.commands.length > 0) {
      entry.postSessionCheck = { commands: profile.commands };
    }
    repos[r] = entry;
  }

  const issues = spec.issues.map((issue) => {
    const number = issue.number;
    const out = {
      number,
      slug: issue.slug || deriveSlug(number, issue.title),
      repo: repoOfIssue(issue, spec),
      dependsOn: [], // every ready-wave issue is independent → one flat parallel wave
      description: issue.digest || 'See the GitHub issue for the canonical spec.',
    };
    // Optional per-issue routing — omitted fields fall back to engine defaults
    // (defaultModel sonnet; effort derived from complexity by the model-effort policy).
    if (issue.complexity) out.complexity = issue.complexity;
    if (issue.model) out.model = issue.model;
    if (issue.effort) out.effort = issue.effort;
    if (issue.extraDirs && issue.extraDirs.length > 0) out.extraDirs = issue.extraDirs;
    return out;
  });

  return {
    name: spec.name,
    configDir: `${spec.stateDir}/state`,
    worktreeDir: `${spec.stateDir}/worktrees`,
    projectRoot: spec.projectRoot,
    stallTimeout: spec.stallTimeout ?? 1800,
    promptTemplate: spec.promptTemplate,
    branchPrefix: 'orchestrator/',
    defaultRepo: spec.repo,
    defaultModel: spec.defaultModel || 'sonnet',
    baseBranch: 'main',
    repos,
    retryOnCheckFailure: { maxRetries: spec.retryMaxRetries ?? 1 },
    issues,
  };
}

// ---- CLI -----------------------------------------------------------------

if (isMain(import.meta.url)) {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: emit-config.mjs <spec.json|->');
    process.exit(2);
  }
  const raw = arg === '-' ? readFileSync(0, 'utf-8') : readFileSync(arg, 'utf-8');
  const spec = JSON.parse(raw);

  const missingCi = unknownCiRepos(spec);
  if (missingCi.length > 0) {
    console.error(
      `emit-config: WARNING — no CI profile for ${missingCi.length} repo(s): ${missingCi.join(', ')}. ` +
        `Those sessions will run with no post-session check. Add them to references/repo-ci-profiles.json.`,
    );
  }

  const config = buildConfig(spec);
  process.stdout.write(JSON.stringify(config, null, 2) + '\n');
}
