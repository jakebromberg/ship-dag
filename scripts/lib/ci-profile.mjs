// ci-profile.mjs — a repo's local CI, resolved in one place for SKILL.md step 4 (the engine's post-session check),
// step 5's green path and step 6.2 (the leased re-run). A registry entry in references/repo-ci-profiles.json with
// commands wins: entries are deliberate overrides (a stack-free subset, a retry around a macOS race). Otherwise a
// repo declares its own CI by committing an executable `scripts/ci`, and the commands are that one command. Otherwise
// there are none, and the wave lands unverified (emit-config warns).
//
// Presence is read from the repo's base branch on GitHub, never from the PR branch, so an implementer cannot add or
// remove its own check, and every step sees what step 4 saw however stale a local `origin/<base>` is.
import { readFileSync } from 'node:fs';
import { ghCli, ghErrorBody, ghFailure, withBackoff } from './gh.mjs';

/** The command a repo-declared CI runs: an executable `scripts/ci`, run from the worktree root. */
export const REPO_CI_COMMAND = 'scripts/ci';

const PROFILES = new URL('../../references/repo-ci-profiles.json', import.meta.url);

/** The registry's `profiles` map, keyed by `owner/repo`. */
export function loadProfiles(path = PROFILES) {
  return JSON.parse(readFileSync(path, 'utf8')).profiles;
}

/**
 * `{ repo, baseBranch, commands, source }` for `repo`: the registry entry's commands (`source: 'registry'`), else
 * `[REPO_CI_COMMAND]` when `hasScript` (`'repo'`), else `[]` (`'none'`). `baseBranch` is the entry's, else `main`.
 */
export function resolveCiProfile(repo, profiles, { hasScript = false } = {}) {
  const entry = profiles[repo];
  const baseBranch = entry?.baseBranch || 'main';
  if (Array.isArray(entry?.commands) && entry.commands.length > 0) return { repo, baseBranch, commands: entry.commands, source: 'registry' };
  if (hasScript) return { repo, baseBranch, commands: [REPO_CI_COMMAND], source: 'repo' };
  return { repo, baseBranch, commands: [], source: 'none' };
}

/**
 * Whether `repo` has a `scripts/ci` file on `base`, asked of the contents API with rate-limit backoff. A REST 404 is
 * absent, and so is a directory of that name. A 404 for the ref itself, and any other failure, throws naming the repo:
 * reading either as absent would land a wave unverified without saying why.
 */
export async function repoHasCiScript(repo, base, { gh = ghCli, sleep } = {}) {
  const args = ['api', `repos/${repo}/contents/${REPO_CI_COMMAND}?ref=${encodeURIComponent(base)}`];
  let out;
  try {
    out = await withBackoff(() => gh(args), { repo, sleep });
  } catch (err) {
    const { status } = ghFailure(err);
    const said = ghErrorBody(err)?.message;
    if (status === 404) {
      if (!/^No commit found for the ref/.test(said ?? '')) return false;
      throw new Error(`${repo}: base branch ${base} not found; set its baseBranch in references/repo-ci-profiles.json`);
    }
    throw new Error(`${repo}: could not read ${REPO_CI_COMMAND} on ${base}: ${said ? `${said} (HTTP ${status})` : err.message}`);
  }
  try {
    const body = JSON.parse(out);
    return !Array.isArray(body) && body?.type === 'file';
  } catch (err) {
    throw new Error(`${repo}: could not read ${REPO_CI_COMMAND} on ${base}: ${err.message}`);
  }
}

/** `resolveCiProfile` for `repo`, asking GitHub for `scripts/ci` only when the registry has no commands for it. */
export async function ciProfileFor(repo, { profiles = loadProfiles(), gh, sleep } = {}) {
  const resolved = resolveCiProfile(repo, profiles);
  if (resolved.source === 'registry') return resolved;
  return resolveCiProfile(repo, profiles, { hasScript: await repoHasCiScript(repo, resolved.baseBranch, { gh, sleep }) });
}
