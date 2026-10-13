// hooks.mts — worktree + cutover wiring for /ship-dag's engine-invocation path.
//
// Loaded by run.mts via loadYamlConfig(..., { hooksOverride }). Worktree lifecycle
// comes from the reusable deriveWorktreeHooks (claude-orchestrator A2): for each
// issue it locates the repo's checkout under the org checkout root (reposDir,
// resolved from the environment by reposDirFromEnv — see below), forks a branch
// off that repo's OWN base branch (derived from origin/HEAD, so a repo on
// `master` is honored, not assumed `main`), and creates the worktree in the
// sibling <repo>-worktrees/ directory (or beside the checkout for a submodule
// package; see repo-layout.mjs). Per-repo CI + the merge-step base branch
// come from the `repos:` map that emit-config.mjs writes into the config.
//
// `.mts` (not `.ts`) so tsx always treats this as ESM — the dynamic import of the
// engine from a runtime $CO_HOME path needs top-level await, which CJS rejects.
//
// confirmCutover is the human-in-the-loop cutover gate — but /ship-dag hands the
// engine ONE ready wave of independent issues at a time (every issue has
// dependsOn: []), so a cross-repo edge never falls INSIDE an engine run; the
// skill's step-7 point-C gate handles cross-repo cutovers between waves. This
// hook is a backstop: on the rare gate node it holds unless a human approves (or
// AUTO_CONFIRM_CUTOVER=1 opts an unattended run in after out-of-band verification).

import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { coDistPath } from "../lib/co-home.mjs";
import { reposDirFromEnv } from "./repos-dir.mjs";
import { repoDirName, worktreeRootFor } from "./repo-layout.mjs";

const coreUrl = pathToFileURL(coDistPath(process.env, "index.js")).href;
const { deriveWorktreeHooks } = await import(coreUrl);

// reposDir = SHIP_DAG_REPOS_DIR ?? SHIP_DAG_PROJECT_ROOT ?? engine default. Passing
// undefined when neither is set preserves deriveWorktreeHooks's own default, so a
// run that sets no env var is unchanged. Per-repo base branch is still origin/HEAD.
const reposDir = reposDirFromEnv();

// repoOf / worktreeRoot break the two layout assumptions the engine's defaults
// make — that a checkout is named after its repo, and that worktrees can live in
// an adjacent `<repoDir>-worktrees/`. Both hold for the ordinary org layout and
// neither holds for a repo vendored as a submodule under a package directory
// (see repo-layout.mjs). Resolution is per-repo and falls back to the engine's
// own behaviour, so repos in the ordinary layout are unaffected.
const worktree = deriveWorktreeHooks({
  reposDir,
  repoOf: (issue: { repo?: string; number?: number; slug?: string }) => {
    if (!issue.repo) {
      throw new Error(
        `deriveWorktreeHooks: issue #${issue.number} (${issue.slug}) has no repo; ` +
          `a cross-repo worktree needs a repo. Set "repo" on the issue.`,
      );
    }
    return repoDirName(issue.repo, { reposDir });
  },
  worktreeRoot: (repoDir: string) => worktreeRootFor(repoDir),
});

const hooksOverride = {
  ...worktree,

  async confirmCutover(issue: { ref: string; slug: string }, reason: string): Promise<boolean> {
    if (process.env.AUTO_CONFIRM_CUTOVER === "1") return true;
    // No tty to prompt on (e.g. a --detach run) → hold; a later interactive run
    // re-evaluates the gate and can approve it.
    if (!process.stdin.isTTY) return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(
        `\nCutover gate — ${issue.ref} (${issue.slug}): ${reason}\n` +
          `Release this issue and its dependents? [y/N] `,
      );
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  },
};

export default hooksOverride;
