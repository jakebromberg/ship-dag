// ci-profile.mjs — a repo's local CI, resolved in one place for SKILL.md step 4 (the engine's post-session check),
// step 5's green path and step 6.2 (the leased re-run). A registry entry in references/repo-ci-profiles.json with
// commands wins: entries are deliberate overrides (a stack-free subset, a retry around a macOS race). Otherwise a
// repo declares its own CI by committing an executable `scripts/ci`, and the commands are that one command. Otherwise
// there are none, and the wave lands unverified (emit-config warns).
//
// Whether `scripts/ci` exists is read from the repo's base branch on GitHub (the registry's `baseBranch`, else the
// repo's default branch), never from the PR branch, so a branch cannot switch the check on or off. What runs is the
// worktree's copy, as `npm run lint` runs the branch's package.json: a branch that weakens its own `scripts/ci` is the
// review gate's to catch. Steps 5 and 6.2 look again when they run, and run `scripts/ci` only when the worktree has it
// (`inWorktree`), so a script merged after step 4 never runs in a worktree that predates it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghCli, ghErrorBody, ghFailure, withBackoff } from './gh.mjs';

/** The command a repo-declared CI runs: an executable `scripts/ci`, run from the worktree root. */
export const REPO_CI_COMMAND = 'scripts/ci';

const PROFILES = new URL('../../references/repo-ci-profiles.json', import.meta.url);
const EXECUTABLE = 0o100755;

/** What is wrong with a registry `localLint`, or '' when it is absent or well formed: an object with a non-blank string `command` (a typo'd key must not silently drop the rule), `forbid` an array of non-blank strings, `note` a string. */
export function localLintProblem(l) {
  if (l == null) return '';
  if (typeof l !== 'object' || Array.isArray(l)) return 'must be an object';
  if (typeof l.command !== 'string' || !l.command.trim()) return 'command must be a non-blank string';
  if (l.forbid != null && !(Array.isArray(l.forbid) && l.forbid.every((f) => typeof f === 'string' && f.trim()))) return 'forbid must be an array of non-blank strings';
  if (l.note != null && typeof l.note !== 'string') return 'note must be a string';
  return '';
}

/**
 * The "Local lint (binding)" rule for a registry `localLint` (`{command, forbid?, note?}`), or '' when it declares no
 * command. The one renderer for every implement path: emit-config appends it to the engine description, and SKILL.md's
 * fallbacks append `ci-profile.mjs --local-lint-rule <repo>` to the digest. It claims only what the registry says;
 * `note` is where a repo describes what its command lints.
 */
export function localLintRule(localLint) {
  const command = typeof localLint?.command === 'string' ? localLint.command.trim() : '';
  if (!command) return '';
  const forbid = (localLint.forbid ?? []).map((c) => `\`${c}\``);
  const list = forbid.length > 1 ? `${forbid.slice(0, -1).join(', ')} or ${forbid.at(-1)}` : forbid[0];
  return `Local lint (binding): for the lint step of local CI, run \`${command}\`.${list ? ` Never run ${list} in this session.` : ''}${localLint.note ? ` ${localLint.note}` : ''}`;
}

/** The registry's `profiles` map, keyed by `owner/repo`. */
export function loadProfiles(path = PROFILES) {
  return JSON.parse(readFileSync(path, 'utf8')).profiles;
}

const registryCommands = (entry) => (Array.isArray(entry?.commands) && entry.commands.length > 0 ? entry.commands : null);

/**
 * `{ repo, baseBranch, commands, source }` for `repo`: the registry entry's commands (`source: 'registry'`), else
 * `[REPO_CI_COMMAND]` when `hasScript` (`'repo'`), else `[]` (`'none'`). `baseBranch` is the entry's, else
 * `defaultBranch` (the repo's, from `repoCiScript`), else `main`. The entry's `host`, `toolchains` and `localLint`, when it sets
 * them, ride along for split-by-host.mjs.
 */
export function resolveCiProfile(repo, profiles, { hasScript = false, defaultBranch } = {}) {
  const entry = profiles[repo];
  const baseBranch = entry?.baseBranch || defaultBranch || 'main';
  const registry = registryCommands(entry);
  const placement = Object.fromEntries(['host', 'toolchains', 'localLint'].filter((k) => entry?.[k] !== undefined).map((k) => [k, entry[k]]));
  if (registry) return { repo, baseBranch, commands: registry, source: 'registry', ...placement };
  if (hasScript) return { repo, baseBranch, commands: [REPO_CI_COMMAND], source: 'repo', ...placement };
  return { repo, baseBranch, commands: [], source: 'none', ...placement };
}

// One query reads the default branch, the named base (when there is one) and `scripts/ci`'s mode on it. A missing
// file is `file: null` plus a NOT_FOUND error at a path ending in `file`, which makes gh exit 1 with the body on stdout.
const QUERY = `query($owner: String!, $name: String!, $path: String!, $qualified: String!, $hasBase: Boolean!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name target { ... on Commit { file(path: $path) { mode type } } } }
    ref(qualifiedName: $qualified) @include(if: $hasBase) { name target { ... on Commit { file(path: $path) { mode type } } } }
  }
}`;

/** The answer's body: stdout, or a failed call's body when its only errors are the missing file. */
function answerBody(out, err) {
  if (!err) return JSON.parse(out);
  const body = ghErrorBody(err);
  const errors = body?.errors;
  const fileMissing = Array.isArray(errors) && errors.length > 0 && errors.every((e) => e?.type === 'NOT_FOUND' && e.path?.at(-1) === 'file');
  return fileMissing || body?.data?.repository === null ? body : null;
}

/**
 * `{ defaultBranch, hasScript }`: whether `repo` has an executable `scripts/ci` on `base` (or, with no `base`, on its
 * default branch), asked of GitHub's GraphQL API with rate-limit backoff. A missing file, or a directory of that name,
 * is absent. A file that is not executable, a missing or unreadable repo, a missing base branch, and any other failure
 * throw, naming the repo: reading any of them as absent would land a wave unverified without saying why.
 */
export async function repoCiScript(repo, base, { gh = ghCli, sleep } = {}) {
  const [owner, name] = repo.split('/');
  const args = ['api', 'graphql', '-f', `query=${QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `path=${REPO_CI_COMMAND}`,
    '-f', `qualified=${base ? `refs/heads/${base}` : ''}`, '-F', `hasBase=${Boolean(base)}`];
  let body;
  try {
    body = answerBody(await withBackoff(() => gh(args), { repo, sleep }));
  } catch (err) {
    body = answerBody(null, err);
    if (!body) {
      if (err.message.startsWith(`${repo}: `)) throw err; // withBackoff's exhausted rate limit already names the repo
      const said = ghErrorBody(err)?.message;
      throw new Error(`${repo}: could not look up ${REPO_CI_COMMAND}: ${said ? `${said} (HTTP ${ghFailure(err).status})` : err.message}`);
    }
  }
  const repository = body.data?.repository;
  if (!repository) throw new Error(`${repo}: repository not found, or this token cannot read it`);
  const defaultBranch = repository.defaultBranchRef?.name;
  if (!defaultBranch) throw new Error(`${repo}: has no default branch; set its baseBranch in references/repo-ci-profiles.json`);
  const branch = base ? repository.ref : repository.defaultBranchRef;
  if (!branch) throw new Error(`${repo}: base branch ${base} not found; set its baseBranch in references/repo-ci-profiles.json`);
  const file = branch.target?.file;
  if (file?.type !== 'blob') return { defaultBranch, hasScript: false };
  if (file.mode !== EXECUTABLE) {
    throw new Error(`${repo}: ${REPO_CI_COMMAND} on ${branch.name} is not executable (mode ${file.mode.toString(8)}); commit it with chmod +x`);
  }
  return { defaultBranch, hasScript: true };
}

/** `resolveCiProfile` for `repo`, asking GitHub for `scripts/ci` only when the registry has no commands for it. */
export async function ciProfileFor(repo, { profiles = loadProfiles(), gh, sleep } = {}) {
  if (registryCommands(profiles[repo])) return resolveCiProfile(repo, profiles);
  return resolveCiProfile(repo, profiles, await repoCiScript(repo, profiles[repo]?.baseBranch, { gh, sleep }));
}

/**
 * `profile` as it applies to `worktree`: a repo-declared profile whose worktree has no `scripts/ci` (a branch cut
 * before the script merged) has no commands, as step 4 configured none for it. Any other profile is returned as is.
 */
export function inWorktree(profile, worktree) {
  if (profile.source !== 'repo' || existsSync(join(worktree, REPO_CI_COMMAND))) return profile;
  return { ...profile, commands: [], source: 'none' };
}
