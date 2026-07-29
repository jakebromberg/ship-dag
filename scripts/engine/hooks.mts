// hooks.mts — worktree + cutover wiring for /ship-dag's engine-invocation path.
//
// Loaded by run.mts via loadYamlConfig(..., { hooksOverride }). Worktree lifecycle
// comes from the reusable deriveWorktreeHooks (claude-orchestrator A2): for each
// issue it locates the repo's checkout under ~/Developer/WXYC, forks a branch off
// that repo's OWN base branch (derived from origin/HEAD, so wxyc-ios-64's
// `master` is honored, not assumed `main`), and creates the worktree in the
// sibling <repo>-worktrees/ directory. Per-repo CI + the merge-step base branch
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
import path from "node:path";
import { pathToFileURL } from "node:url";

const CO_HOME = process.env.CO_HOME || "/Users/me/Developer/claude-orchestrator";
const coreUrl = pathToFileURL(path.join(CO_HOME, "dist/src/index.js")).href;
const { deriveWorktreeHooks } = await import(coreUrl);

const worktree = deriveWorktreeHooks(); // ~/Developer/WXYC, per-repo base from origin/HEAD

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
