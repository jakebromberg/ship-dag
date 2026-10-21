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
//         "triagedAt": "2026-10-16T12:00:00Z",  // optional; when triage ran (ISO 8601; no zone = UTC) — the CLI reads each #N / owner/repo#N the digest and decisions name and prepends a note of those that merged or closed since (a failed read: "state unknown"); absent, the description is unchanged
//         "baseSha": "<sha>" }                  // optional; the base branch's SHA at triage time — carried for the base-commits follow-up, not read today
//     ]
//   }
//
// Usage:
//   node emit-config.mjs <spec.json|->            # read spec (stdin with -), write config JSON to stdout
//   node emit-config.mjs <spec.json> > config.json
//   node emit-config.mjs <spec.json|-> --by-host <dir>   # write <dir>/config.<host>.json for each host that has an issue (config.local.json included), print their paths
//
// Hosts (--by-host only): an issue runs on its own `host`, else its repo's `repos[repo].host`, else `local`; see
// lib/split-by-host.mjs for the toolchain guard and the paths a remote host's config takes from references/hosts.json.
// An unknown host, or an explicit issue `host` that lacks a toolchain its CI needs, exits 2 naming the issue. `host` never reaches the engine config.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringOption } from './lib/cli-args.mjs';
import { loadHosts } from './lib/hosts.mjs';
import { isMain } from './lib/is-main.mjs';
import { realRunGh } from './lib/gh.mjs';
import { refKey } from './lib/ref.mjs';
import { splitByHost } from './lib/split-by-host.mjs';
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
// decisions (one read each, none when there are none) and returns a block of facts to prepend: the refs that
// merged or closed since `triagedAt`, and any whose read failed, named "state unknown" (a failed read warns and
// never stops the emit). It states facts only and never rewrites the digest. `readRef(repo, number)` is
// injected and returns the GitHub issues-API row `{state, title, closed_at, pull_request}`. `triagedAt` is
// stamped by the main agent (a model's return is only a fallback), so a strict ISO 8601 time is read, a
// time with no zone as UTC, and anything else is ignored with a warning. Without a `triagedAt` or a reader,
// or when nothing changed, the description comes back untouched.
// Not refs worth a read: URLs; a bare `#N` that is a hex colour (6 or 8 digits, or one digit three times) or an
// ordinal (one digit); and an owner-less `repo#N` with no space ("dj-site#5"), which the lookbehind skips. Every
// other bare `#N` is read against the issue's own repo, whatever word precedes it ("follow-up #12", "CI #12",
// "dj-site #12"), because a sibling ref is the case the note exists for. An `owner/repo#N` is always a ref,
// whatever its number looks like.
const REF_IN_TEXT = /(?<![\w#/])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g;
const NOT_A_REF = /^(\d)\1\1$|^(\d{6}|\d{8})$/;
const ISO_TIME = /^(\d{4}-\d{2}-\d{2})(?:[Tt ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/** Epoch ms of a strict ISO 8601 time (a space may stand for the T; no zone means UTC), else NaN. */
function parseTriagedAt(text) {
  const m = ISO_TIME.exec(String(text).trim());
  if (!m) return NaN;
  const zone = !m[3] ? 'Z' : m[3].toUpperCase() === 'Z' ? 'Z' : m[3].replace(/^([+-]\d{2}):?(\d{2})?$/, (_, h, mm) => `${h}:${mm ?? '00'}`);
  return Date.parse(`${m[1]}T${m[2] ?? '00:00'}${zone}`);
}

export function withMergedSinceTriage(description, { texts, repo, self, base, triagedAt, readRef, warn = () => {} }) {
  if (!triagedAt || !readRef) return description;
  const since = parseTriagedAt(triagedAt);
  if (!Number.isFinite(since)) {
    warn(`emit-config: WARNING — triagedAt "${triagedAt}" is not an ISO 8601 time; no since-triage note for #${self}`);
    return description;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(triagedAt).trim())) {
    warn(`emit-config: WARNING — triagedAt "${triagedAt}" is a date only; read as 00:00 UTC, so closes earlier that day count as since triage (#${self})`);
  }
  const refs = new Map();
  const text = texts.join('\n').replace(/\bhttps?:\/\/\S+/g, ' ');
  for (const m of text.matchAll(REF_IN_TEXT)) {
    const r = m[1] ?? repo;
    const n = Number(m[2]);
    if (refKey(r) === refKey(repo) && n === self) continue;
    if (!m[1] && (NOT_A_REF.test(m[2]) || m[2].length === 1)) continue;
    const key = `${refKey(r)}#${n}`;
    if (!refs.has(key)) refs.set(key, { r, n, label: m[1] ? `${m[1]}#${n}` : `#${n}` });
  }
  const changed = [], unknown = [];
  for (const { r, n, label } of refs.values()) {
    let row;
    try { row = readRef(r, n); } catch (err) {
      warn(`emit-config: WARNING — could not read ${r}#${n}; the since-triage note names its state unknown: ${err.message}`);
      unknown.push(`${label} state unknown`);
      continue;
    }
    const mergedAt = row?.pull_request?.merged_at;
    const at = Date.parse(mergedAt ?? row?.closed_at);
    if (row?.state !== 'closed' || !(at > since)) continue;
    changed.push(mergedAt ? `${label} merged (${row.title})` : `${label} closed`);
  }
  const facts = [...changed, ...unknown];
  if (facts.length === 0) return description;
  const settled = changed.length > 0 ? ' Conditionals in the plan that name a merged or closed one are settled.' : '';
  return `Since this plan was written: ${facts.join('; ')}.${settled} Read each file the plan names on \`origin/${base}\` before editing it.\n\n${description}`;
}

/** The real `readRef`: one `gh api` read of an issue or PR, via the issues endpoint that serves both, cut off after 15 s so a stalled `gh` cannot hold the emit. */
export const ghReadRef = (repo, number, run = realRunGh) => JSON.parse(run(['api', `repos/${repo}/issues/${number}`], { timeout: 15000 }));

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
  const memo = new Map(); // one read per ref across the whole wave; a failed read is remembered too, so a stalled gh is waited on once
  const readOnce = readRef && ((repo, number) => {
    const key = `${refKey(repo)}#${number}`;
    if (!memo.has(key)) {
      try { memo.set(key, { row: readRef(repo, number) }); } catch (err) { memo.set(key, { err }); }
    }
    const hit = memo.get(key);
    if (hit.err) throw hit.err;
    return hit.row;
  });
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
        { texts: [issue.digest ?? '', ...(issue.decisions ?? [])], repo: repoOfIssue(issue, spec), self: number, base: repos[repoOfIssue(issue, spec)].baseBranch, triagedAt: issue.triagedAt, readRef: readOnce, warn },
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

/**
 * `buildConfig` for each host that has an issue, in `splitByHost`'s order: `[{ host, spec, config }]`, `spec` being
 * the sub-spec the config was built from. `opts.warn` also receives the toolchain guard's warnings.
 */
export function buildConfigsByHost(spec, hosts, tuning = loadTuning(), opts = {}) {
  return Object.entries(splitByHost(spec, hosts, opts.warn)).map(([host, sub]) => ({ host, spec: sub, config: buildConfig(sub, tuning, opts) }));
}

// ---- CLI -----------------------------------------------------------------

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  let byHost;
  try {
    byHost = stringOption(argv, '--by-host');
  } catch (err) {
    console.error(`emit-config: ${err.message}`);
    process.exit(2);
  }
  const arg = argv.find((a, i) => a !== '--by-host' && argv[i - 1] !== '--by-host');
  if (!arg) {
    console.error('Usage: emit-config.mjs <spec.json|-> [--by-host <dir>]');
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

  let built;
  let tuning;
  try {
    tuning = loadTuning();
    const opts = { readRef: ghReadRef, warn: console.error };
    built = byHost === undefined ? [{ host: 'local', spec, config: buildConfig(spec, tuning, opts) }] : buildConfigsByHost(spec, loadHosts(), tuning, opts);
  } catch (err) {
    console.error(`emit-config: ${err.message}`);
    process.exit(2);
  }
  const json = (config) => JSON.stringify(config, null, 2) + '\n';
  if (byHost === undefined) {
    process.stdout.write(json(built[0].config));
  } else {
    mkdirSync(byHost, { recursive: true });
    for (const { host, config } of built) {
      const path = join(byHost, `config.${host}.json`);
      writeFileSync(path, json(config));
      process.stdout.write(`${path}\n`);
    }
  }
  // After the config is out, so a sidecar failure can never change or block it. A host's engine reports only its own
  // issues, so each host gets its own line, all in the run's local stateDir.
  for (const { spec: s, config } of built) {
    try {
      appendWave(spec.stateDir, waveSidecar(s, { config, tuning }));
    } catch (err) {
      console.error(`emit-config: WARNING — could not build the wave sidecar: ${err.message}`);
    }
  }
}
