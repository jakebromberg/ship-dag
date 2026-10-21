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
//     "runId":          "sd-20261008-153059",       // optional; the run id (default: parsed from `name`) — recorded in the wave sidecar
//     "wave":           "14b",                       // optional; the wave counter W (a number or a string such as "14b") — recorded in the wave sidecar
//     "blockOn":        "correctness,security",      // optional; the run's --block-on, as that comma string or an array — recorded (parsed) in the wave sidecar; an unknown category exits 2
//     "repos": {                                    // per-repo base branch + CI profile: ci-profile.mjs prints this map (its `source` is ignored)
//       "owner/repo": { "baseBranch": "main", "commands": ["ruff check .", "pytest -q"] }
//     },
//     "issues": [
//       { "number": 924, "repo": "owner/repo", "title": "...", "complexity": "normal",
//         "model": "opus", "effort": "high", "digest": "2-3 sentence plan", "extraDirs": ["../wxyc-shared"],
//         "reach": "repo",                         // optional; in-diff|repo|external (a key of tuning review.reachEffort; unknown exits 2) — recorded in the wave sidecar, not the engine config
//         "decisions": ["use JSONL"],           // optional; array of strings (anything else exits 2) — recorded in the wave sidecar and folded into the engine description as a "Settled decisions" list
//         "triagedAt": "2026-10-16T12:00:00Z" }    // optional; when triage ran (ISO 8601) — the CLI reads each #N / owner/repo#N the digest and decisions name and prepends a note of those that merged or closed since; absent, the description is unchanged
//     ]
//   }
//
// Usage:
//   node emit-config.mjs <spec.json|->            # read spec (stdin with -), write config JSON to stdout
//   node emit-config.mjs <spec.json> > config.json

import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isMain } from './lib/is-main.mjs';
import { realRunGh } from './lib/gh.mjs';
import { refKey } from './lib/ref.mjs';
import { load as loadTuning } from './lib/tuning.mjs';
import { waveSidecar, appendWave, specBlockOn } from './lib/wave-sidecar.mjs';

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

/** An issue named `owner/repo#N`, so a refusal in a cross-repo wave says which repo's triage output to fix. */
function issueRef(issue, spec) {
  return `${repoOfIssue(issue, spec)}#${issue.number}`;
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

/** The implement effort tuning.json maps `complexity` to, or undefined (string own keys only). */
function tunedEffort(tuning, complexity) {
  return typeof complexity === 'string' && Object.hasOwn(tuning.implement, complexity) ? tuning.implement[complexity] : undefined;
}

/**
 * Issues whose `complexity` is set but is not a key of tuning.json's implement map,
 * as `{ number, ref, complexity }` (`ref` is `owner/repo#N`). buildConfig refuses a spec with any: running such an
 * issue at the default effort could silently under-power it, and the engine schema
 * rejects an unknown complexity anyway.
 */
export function unknownComplexities(spec, tuning = loadTuning()) {
  return spec.issues
    .filter((i) => i.complexity && tunedEffort(tuning, i.complexity) === undefined)
    .map((i) => ({ number: i.number, ref: issueRef(i, spec), complexity: i.complexity }));
}

// Triage's per-issue line budget rides on the *description*, not on a new field.
// The engine interpolates a fixed set of prompt variables (ISSUE_NUMBER, SLUG,
// DESCRIPTION, ...) and leaves any unrecognized `{{...}}` placeholder intact, so
// a `{{SOURCE_ESTIMATE}}` would leak literally into the implementer's prompt.
// DESCRIPTION is the one channel that carries arbitrary triage text through.
// A missing, zero, negative, or non-numeric estimate is dropped rather than
// rendered — an implementer told its budget is "NaN lines" is worse off than one
// told nothing, who falls back to the prompt template's standing 200-line rule.
export function withLineBudget(description, sourceEstimate) {
  const n = Number(sourceEstimate);
  if (!Number.isFinite(n) || n <= 0) return description;
  return `${description}\n\nSize budget: about ${Math.round(n)} added lines of production source. Tests, generated data, and docs sit outside the budget — do not trim them to fit. If the change runs more than half again past it, stop at the last green, coherent point and push that.`;
}

// Triage's `decisions` ride on the description for the same reason: the implementer reads
// DESCRIPTION, and the review enforces these as binding, so the implementer must see them
// (the wave sidecar still records them, unchanged). One decision per line, each kept verbatim
// but for line breaks (LF, CR, U+2028, U+2029), which would split it, and trimmed ends; the engine
// enforces no description size limit, so none is dropped. No decisions (absent, null, empty or all blank) returns the description untouched.
export function withDecisions(description, decisions) {
  const lines = (decisions ?? []).map((d) => d.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ').trim()).filter(Boolean);
  if (lines.length === 0) return description;
  return `${description}\n\nSettled decisions (binding; they override the issue body where they differ):\n${lines.map((d) => `- ${d}`).join('\n')}`;
}

// A triage digest is written once, but a wave can launch a day or more later, so the PRs and issues it
// names as open or conditional may have landed. This collects every `#N` / `owner/repo#N` in the digest and
// decisions (one read each, none when there are none) and, for those that closed since `triagedAt`, returns
// a block of facts to prepend. It states facts only and never rewrites the digest. `readRef(repo, number)`
// is injected and returns the GitHub issues-API row `{state, title, closed_at, pull_request}`; a read that
// throws drops that ref's line and warns, so a failure never stops the emit. Without a `triagedAt` or a
// reader, or when nothing changed, the description comes back untouched.
const REF_IN_TEXT = /(?<![\w#])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g;

export function withMergedSinceTriage(description, { texts, repo, self, base, triagedAt, readRef, warn = () => {} }) {
  if (!triagedAt || !readRef) return description;
  const since = Date.parse(triagedAt);
  if (!Number.isFinite(since)) return description;
  const refs = new Map();
  for (const m of texts.join('\n').matchAll(REF_IN_TEXT)) {
    const r = m[1] ?? repo;
    const n = Number(m[2]);
    if (refKey(r) === refKey(repo) && n === self) continue;
    refs.set(`${refKey(r)}#${n}`, { r, n, label: m[1] ? `${m[1]}#${n}` : `#${n}` });
  }
  const facts = [];
  for (const { r, n, label } of refs.values()) {
    let row;
    try { row = readRef(r, n); } catch (err) {
      warn(`emit-config: WARNING — could not read ${r}#${n}; left out of the since-triage note: ${err.message}`);
      continue;
    }
    const mergedAt = row?.pull_request?.merged_at;
    const at = Date.parse(mergedAt ?? row?.closed_at);
    if (row?.state !== 'closed' || !(at > since)) continue;
    facts.push(mergedAt ? `${label} merged (${row.title})` : `${label} closed`);
  }
  if (facts.length === 0) return description;
  return `Since this plan was written: ${facts.join('; ')}. Conditionals in the plan that name them are settled. Read each file the plan names on \`origin/${base}\` before editing it.\n\n${description}`;
}

/** The real `readRef`: one `gh api` read of an issue or PR, via the issues endpoint that serves both. */
export const ghReadRef = (repo, number) => JSON.parse(realRunGh(['api', `repos/${repo}/issues/${number}`]));

/**
 * Refuse a spec the emitter must not run, throwing one error that lists every
 * problem at once (unknown complexity, reach or decisions, invalid blockOn). buildConfig calls this
 * first, so the library and the CLI refuse exactly the same specs; a new spec
 * rule is one more check here.
 */
export function validateSpec(spec, tuning = loadTuning()) {
  const errors = [];
  const unknown = unknownComplexities(spec, tuning);
  if (unknown.length > 0) {
    errors.push(`unknown complexity on ${unknown.map((i) => `${i.ref} (${i.complexity})`).join(', ')}; `
      + `known: ${Object.keys(tuning.implement).join('/')}. Fix the triage output and re-emit.`);
  }
  const reaches = Object.keys(tuning.review.reachEffort);
  const badReach = spec.issues.filter((i) => i.reach != null && !(typeof i.reach === 'string' && reaches.includes(i.reach)));
  if (badReach.length > 0) {
    errors.push(`unknown reach on ${badReach.map((i) => `${issueRef(i, spec)} (${JSON.stringify(i.reach)})`).join(', ')}; known: ${reaches.join('/')}.`);
  }
  const badDecisions = spec.issues.filter((i) => i.decisions != null && !(Array.isArray(i.decisions) && i.decisions.every((d) => typeof d === 'string')));
  if (badDecisions.length > 0) {
    errors.push(`decisions must be an array of strings on ${badDecisions.map((i) => issueRef(i, spec)).join(', ')}.`);
  }
  try {
    specBlockOn(spec.blockOn);
  } catch (err) {
    errors.push(err.message);
  }
  if (errors.length > 0) throw new Error(errors.join(' '));
}

/**
 * Build the engine config object from a ready-wave spec.
 * @param spec   the ready-wave spec (shape in the header comment).
 * @param tuning a validated version-1 tuning object (see lib/tuning.mjs `load`);
 *               defaults to reading the shipped references/tuning.json from disk.
 * @param opts   `{readRef, warn}`: the injected GitHub reader for the since-triage block (see
 *               withMergedSinceTriage); without a `readRef` no block is built.
 */
export function buildConfig(spec, tuning = loadTuning(), { readRef, warn } = {}) {
  validateSpec(spec, tuning);
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
      description: withMergedSinceTriage(
        withLineBudget(withDecisions(issue.digest || 'See the GitHub issue for the canonical spec.', issue.decisions), issue.sourceEstimate),
        { texts: [issue.digest ?? '', ...(issue.decisions ?? [])], repo: repoOfIssue(issue, spec), self: number, base: repos[repoOfIssue(issue, spec)].baseBranch, triagedAt: issue.triagedAt, readRef, warn },
      ),
    };
    // Optional per-issue routing — omitted fields fall back to engine defaults
    // (defaultModel sonnet). Effort is stamped from tuning.json's implement map when
    // the issue has a complexity, and an issue's own effort wins. An issue with no
    // complexity carries no effort and takes the config-level defaultEffort below,
    // which also comes from tuning.json. Engine retry escalation still applies on top.
    const tuned = tunedEffort(tuning, issue.complexity);
    if (tuned) out.complexity = issue.complexity;
    if (issue.model) out.model = issue.model;
    const effort = issue.effort || tuned;
    if (effort) out.effort = effort;
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
    defaultEffort: tuning.implement.normal,
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
        `Those sessions will run with no post-session check. Commit an executable scripts/ci to each repo, or add it to references/repo-ci-profiles.json.`,
    );
  }

  let config;
  let tuning;
  try {
    tuning = loadTuning();
    config = buildConfig(spec, tuning, { readRef: ghReadRef, warn: console.error });
  } catch (err) {
    console.error(`emit-config: ${err.message}`);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(config, null, 2) + '\n');
  // After the config is out, so a sidecar failure can never change or block it.
  try {
    appendWave(dirname(config.configDir), waveSidecar(spec, { config, tuning }));
  } catch (err) {
    console.error(`emit-config: WARNING — could not build the wave sidecar: ${err.message}`);
  }
}
