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

import path from "node:path";
import { pathToFileURL } from "node:url";

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
