// run.mts — /ship-dag's entry point into the claude-orchestrator engine.
//
// Invoked once per ready wave by SKILL.md step 4:
//
//   SHIP_DAG_CONFIG=<abs config.json> \
//   SHIP_DAG_PROJECT_ROOT=<org checkout root> \
//   CO_HOME=<claude-orchestrator checkout> \
//   npx --prefix "$CO_HOME" tsx scripts/engine/run.mts wave --parallel <K>
//
// It registers the emit-config.mjs-generated config under the fixed key `wave`
// and hands off to the engine's createMain. The engine runs with its default
// mergePolicy "none" — implement each issue in its own per-repo worktree, run
// per-repo CI, open a PR, then STOP. It never merges: the Opus review gate and
// the dependency-ordered merge queue stay in the skill (SKILL.md steps 5–6).
//
// `.mts` (not `.ts`) so tsx always treats this as ESM — the dynamic import of the
// engine from a runtime $CO_HOME path needs top-level await, which CJS rejects.
//
// The config's paths (configDir/worktreeDir under a per-run state dir, absolute
// promptTemplate) are absolute, so YAML path resolution against this file's dir
// is a no-op — the bundle is location-independent.
//
// After createMain() returns, a post-run step writes a small routed diagnosis
// for every non-succeeded row (scripts/engine/failure-digest.mjs) — see the
// comment above that call, below. It shares its transcript scan and its output
// shape with scripts/diagnose-failure.mjs, so the eager and on-demand readers
// cannot disagree about the same run.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeFailureDigests } from "./failure-digest.mjs";

const CO_HOME = process.env.CO_HOME || "/Users/jake/Developer/claude-orchestrator";
const indexUrl = pathToFileURL(path.join(CO_HOME, "dist/src/index.js")).href;
const loaderUrl = pathToFileURL(path.join(CO_HOME, "dist/src/yaml-loader.js")).href;

const { createMain } = await import(indexUrl);
const { loadYamlConfig } = await import(loaderUrl);
const { default: hooksOverride } = await import("./hooks.mts");

const configPath = process.env.SHIP_DAG_CONFIG;
if (!configPath) {
  console.error("run.mts: SHIP_DAG_CONFIG must point to the emitted config JSON");
  process.exit(2);
}

await createMain({
  configs: {
    wave: async () => loadYamlConfig(configPath, { hooksOverride }),
  },
  // The org checkout root, so the --detach respawn resolves tsx and relative
  // paths from a stable base rather than the skill dir.
  projectRoot: process.env.SHIP_DAG_PROJECT_ROOT || process.cwd(),
});

// Post-run: digest every non-succeeded row from this run's freshest report, so
// SKILL.md step 4c never has to open a multi-megabyte session transcript by
// hand to learn why a row failed — and so the digest can carry the ROUTE, which
// is the part a terminal reason and an exit code cannot supply on their own: a
// failed row that opened a PR belongs at the review gate, never in a retry. Best-effort (a digest failure must not fail
// the wave) and only reachable on the paths where createMain() actually wrote
// a fresh report — `wave`/`retry-failed`/`run-specific`, foreground or the
// --detach child. Every early-exit mode (--plan, the --detach parent, status/
// help/merge/cleanup/tail/watch/dashboard) calls process.exit() from inside
// createMain and terminates the process before control ever returns here.
try {
  const { configDir } = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const reportsDir = path.join(configDir, "reports");
  const reportFiles = fs.readdirSync(reportsDir).filter((f) => f.endsWith(".json"));
  if (reportFiles.length > 0) {
    const newest = reportFiles
      .map((f) => ({ f, mtimeMs: fs.statSync(path.join(reportsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0].f;
    const report = JSON.parse(fs.readFileSync(path.join(reportsDir, newest), "utf-8"));
    await writeFailureDigests({ configDir, report });
  }
} catch (err) {
  console.error(`run.mts: failed to write failure digests (non-fatal): ${err instanceof Error ? err.message : err}`);
}
