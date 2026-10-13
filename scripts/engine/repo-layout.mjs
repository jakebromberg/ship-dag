// repo-layout.mjs — resolve the two path assumptions deriveWorktreeHooks makes.
//
// The engine's default hooks assume the ordinary org layout: a checkout named
// after its repo, sitting directly under the org root, whose worktrees can live
// in an adjacent `<repoDir>-worktrees/` directory. Both assumptions are false
// for a repo vendored as a git submodule inside a package directory, and the
// failure modes are different:
//
//   1. NAME. `WXYC/wallpaper-ios` is checked out as `Shared/Wallpaper` — the
//      submodule path, not the repo name. deriveWorktreeHooks throws
//      "repo checkout not found" before any session starts.
//
//   2. DEPTH. That package's Package.swift takes six `../` path dependencies
//      (Analytics, Caching, ColorPalette, Core, Logger, WXUI) that resolve only
//      because the checkout is a sibling of them. A worktree in
//      `Shared/wallpaper-ios-worktrees/<slug>/` is one level too deep, so every
//      `../` misses and the build fails inside each session — after the
//      expensive part has already run.
//
// Both are overridable on deriveWorktreeHooks (`repoOf`, `worktreeRoot`); these
// two pure functions decide what to pass. Injected fs/git accessors keep them
// testable; the defaults do the real thing.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

/** `owner/repo` (or a remote URL) reduced to a comparable `owner/repo`, lowercased. */
function normalizeRepo(value) {
  if (!value) return "";
  const trimmed = String(value).trim().replace(/\.git$/i, "");
  // git@host:owner/repo · ssh://host/owner/repo · https://host/owner/repo · owner/repo
  const parts = trimmed.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@]+@/, "").split(/[:/]/).filter(Boolean);
  return parts.slice(-2).join("/").toLowerCase();
}

function defaultListDirs(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name);
}

function gitIn(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

const defaultRemoteOf = (dir) => gitIn(dir, "remote", "get-url", "origin");

/** A linked worktree's git dir differs from its common dir; a checkout's or submodule's does not. */
function defaultIsLinkedWorktree(dir) {
  const [gitDir, commonDir] = gitIn(dir, "rev-parse", "--git-dir", "--git-common-dir").trim().split("\n");
  return path.resolve(dir, gitDir) !== path.resolve(dir, commonDir);
}

/**
 * The on-disk directory name for `repo` under `reposDir`.
 *
 * Prefers the repo's own name (the ordinary layout, and the only case that costs
 * nothing). Falls back to scanning `reposDir` for a checkout whose `origin`
 * remote is the same repo, which covers a submodule path, a renamed clone, and a
 * case-mismatched directory alike. The scan is one level deep, skips linked
 * worktrees (which share the origin), and visits names in sorted order, so the
 * answer does not depend on readdir order. When nothing matches it returns the literal
 * repo name, so the engine still raises its own "clone it under …" error rather
 * than this function inventing a path.
 *
 * @param {string} repo `owner/repo`
 * @returns {string} a directory name, relative to `reposDir`
 */
export function repoDirName(repo, options = {}) {
  const {
    reposDir,
    existsSync = fs.existsSync,
    listDirs = defaultListDirs,
    remoteOf = defaultRemoteOf,
    isLinkedWorktree = defaultIsLinkedWorktree,
  } = options;

  const slash = repo.lastIndexOf("/");
  const literal = slash >= 0 ? repo.slice(slash + 1) : repo;
  if (!reposDir) return literal;
  if (existsSync(path.join(reposDir, literal))) return literal;

  const wanted = normalizeRepo(repo);
  let candidates;
  try {
    candidates = [...listDirs(reposDir)].sort();
  } catch {
    return literal;
  }
  for (const name of candidates) {
    const dir = path.join(reposDir, name);
    try {
      if (normalizeRepo(remoteOf(dir)) === wanted && !isLinkedWorktree(dir)) return name;
    } catch {
      // not a git checkout, or no origin — skip, never throw
    }
  }
  return literal;
}

/**
 * Where worktrees for `repoDir` should be rooted.
 *
 * Default is the engine's own convention, `<repoDir>-worktrees`. A package whose
 * manifest declares `../` path dependencies gets `dirname(repoDir)` instead, so
 * the worktree lands as a sibling of the checkout and those `../` paths keep
 * resolving. `SHIP_DAG_WORKTREE_MODE` (`sibling` | `adjacent`, see
 * worktreeModeOf) overrides the detection in either direction, run-wide.
 *
 * Detection is deliberately narrow — a SwiftPM manifest naming a relative path
 * dependency — because a false positive puts worktrees in a directory holding
 * real checkouts. Anything it cannot read falls back to the safe default.
 *
 * @param {string} repoDir absolute path to the repo checkout
 * @returns {string} absolute path to the worktree root
 */
export function worktreeRootFor(repoDir, options = {}) {
  const {
    existsSync = fs.existsSync,
    readFileSync = fs.readFileSync,
    env = process.env,
    mode = worktreeModeOf(env),
  } = options;

  const adjacent = `${repoDir}-worktrees`;
  const sibling = path.dirname(repoDir);

  if (mode === "sibling") return sibling;
  if (mode === "adjacent") return adjacent;

  const manifest = path.join(repoDir, "Package.swift");
  if (!existsSync(manifest)) return adjacent;
  let source;
  try {
    source = String(readFileSync(manifest, "utf8"));
  } catch {
    return adjacent;
  }
  // `.package(name: "Analytics", path: "../Analytics")` — a dependency reached
  // by walking out of the checkout is what makes the sibling layout load-bearing.
  // Comments are dropped (string literals kept, so a URL's `//` survives) and
  // only a `.package(` declaration counts, never a target's `path:`.
  const code = source.replace(STRING_OR_COMMENT, (m) => (m.startsWith('"') ? m : ""));
  return PATH_DEPENDENCY.test(code) ? sibling : adjacent;
}

const STRING_OR_COMMENT = /"(?:\\.|[^"\\\n])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const PATH_DEPENDENCY = /\.package\s*\(\s*(?:name:\s*"[^"]*"\s*,\s*)?path:\s*"\.\.\//;

const MODES = new Set(["sibling", "adjacent"]);
let warnedMode;

/**
 * The `SHIP_DAG_WORKTREE_MODE` override: `sibling`, `adjacent`, or `""` (detect).
 * An unrecognised value warns once per process on stderr and means detect.
 */
export function worktreeModeOf(env = process.env, warn = (m) => process.stderr.write(`${m}\n`)) {
  const mode = (env.SHIP_DAG_WORKTREE_MODE || "").trim().toLowerCase();
  if (!mode || MODES.has(mode)) return mode;
  if (warnedMode !== mode) {
    warnedMode = mode;
    warn(`ship-dag: ignoring SHIP_DAG_WORKTREE_MODE=${mode} (expected sibling or adjacent); detecting per repo.`);
  }
  return "";
}

function memo(cache, key, compute) {
  if (!cache.has(key)) cache.set(key, compute());
  return cache.get(key);
}

/**
 * deriveWorktreeHooks with this module's layout, resolved once per repo for the
 * life of the process, so all four hooks agree on a path even if the disk
 * changes mid-run (a Package.swift edit, a new sibling worktree).
 *
 * A sibling-mode worktree lands at `<dir of checkout>/<checkout>--<slug>`, a name
 * no real sibling checkout carries; setUpWorktree refuses that path when it
 * exists but is not a registered worktree of the repo, rather than reusing it.
 *
 * @param {Function} deriveWorktreeHooks the engine's factory
 * @param {{reposDir?: string, env?: object}} options
 */
export function layoutWorktreeHooks(deriveWorktreeHooks, options = {}) {
  const { reposDir = path.join(os.homedir(), "Developer", "WXYC"), env = process.env } = options;
  const mode = worktreeModeOf(env);
  const dirNames = new Map();
  const roots = new Map();

  const repoOf = (issue) => {
    if (!issue.repo) {
      throw new Error(`issue #${issue.number} (${issue.slug}) has no repo; a cross-repo worktree needs one.`);
    }
    return memo(dirNames, issue.repo, () => repoDirName(issue.repo, { reposDir }));
  };
  const worktreeRoot = (repoDir) => memo(roots, repoDir, () => worktreeRootFor(repoDir, { mode }));
  const isSibling = (repoDir) => worktreeRoot(repoDir) === path.dirname(repoDir);

  const engine = deriveWorktreeHooks({
    reposDir,
    repoOf,
    worktreeRoot,
    getBranchName: (issue) => `orchestrator/${issue.branchSlug ?? issue.slug}`,
  });

  // Sibling mode: rename the worktree dir, not the branch.
  const placed = (issue) => {
    const repoDir = path.join(reposDir, repoOf(issue));
    if (!isSibling(repoDir)) return { issue, repoDir };
    const slug = `${path.basename(repoDir)}--${issue.slug}`;
    return { issue: { ...issue, slug, branchSlug: issue.slug }, repoDir, sibling: true };
  };

  return {
    ...engine,
    getWorktreePath: (issue) => engine.getWorktreePath(placed(issue).issue),
    async setUpWorktree(issue) {
      const p = placed(issue);
      const wtPath = engine.getWorktreePath(p.issue);
      if (p.sibling && fs.existsSync(wtPath) && !isWorktreeOf(p.repoDir, wtPath)) {
        throw new Error(`refusing ${wtPath}: it exists but is not a worktree of ${p.repoDir}. Move it aside.`);
      }
      return engine.setUpWorktree(p.issue);
    },
    removeWorktree: (issue) => engine.removeWorktree(placed(issue).issue),
  };
}

function isWorktreeOf(repoDir, wtPath) {
  const real = fs.realpathSync(wtPath);
  return gitIn(repoDir, "worktree", "list", "--porcelain")
    .split("\n")
    .some((line) => line.startsWith("worktree ") && fs.realpathSync(line.slice(9)) === real);
}
