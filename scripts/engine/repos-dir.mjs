// repos-dir.mjs — resolve the org checkout root the worktree layer forks from.
//
// /ship-dag hands the claude-orchestrator engine per-repo worktrees created as
// siblings under a single "repos dir" (the org checkout root that holds each
// repo checkout, e.g. `/Users/me/Developer/daisyguide` holding `backend/`).
// hooks.mts threads the result into deriveWorktreeHooks({ reposDir }); passing
// `undefined` lets the engine keep its own default, so a run that sets neither
// env var is unchanged.
//
// Resolution order:
//   1. SHIP_DAG_REPOS_DIR — explicit override for the rare case the repos dir
//      differs from the engine respawn root.
//   2. SHIP_DAG_PROJECT_ROOT — the org checkout root the skill already emits and
//      run.mts consumes; the repos dir and the project root are the same dir in
//      the sibling layout, so reusing it keeps the invocation to one env var.
//   3. undefined — no override; deriveWorktreeHooks applies its built-in default.
//
// An empty-string value is treated as unset (a blank env var must not override).

/**
 * The org checkout root for the worktree layer, or `undefined` to defer to the
 * engine's own default.
 *
 * @param {NodeJS.ProcessEnv} [env] Environment to read (defaults to process.env).
 * @returns {string | undefined}
 */
export function reposDirFromEnv(env = process.env) {
  return env.SHIP_DAG_REPOS_DIR || env.SHIP_DAG_PROJECT_ROOT || undefined;
}
