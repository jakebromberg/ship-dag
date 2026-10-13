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

function defaultRemoteOf(dir) {
  return execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * The on-disk directory name for `repo` under `reposDir`.
 *
 * Prefers the repo's own name (the ordinary layout, and the only case that costs
 * nothing). Falls back to scanning `reposDir` for a checkout whose `origin`
 * remote is the same repo, which covers a submodule path, a renamed clone, and a
 * case-mismatched directory alike. When nothing matches it returns the literal
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
  } = options;

  const slash = repo.lastIndexOf("/");
  const literal = slash >= 0 ? repo.slice(slash + 1) : repo;
  if (!reposDir) return literal;
  if (existsSync(path.join(reposDir, literal))) return literal;

  const wanted = normalizeRepo(repo);
  let candidates;
  try {
    candidates = listDirs(reposDir);
  } catch {
    return literal;
  }
  for (const name of candidates) {
    const dir = path.join(reposDir, name);
    let remote;
    try {
      remote = remoteOf(dir);
    } catch {
      continue; // not a git checkout, or no origin — skip, never throw
    }
    if (normalizeRepo(remote) === wanted) return name;
  }
  return literal;
}

/**
 * Where worktrees for `repoDir` should be rooted.
 *
 * Default is the engine's own convention, `<repoDir>-worktrees`. A package whose
 * manifest declares `../` path dependencies gets `dirname(repoDir)` instead, so
 * the worktree lands as a sibling of the checkout and those `../` paths keep
 * resolving. `SHIP_DAG_WORKTREE_MODE` (`sibling` | `adjacent`) overrides the
 * detection in either direction.
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
  } = options;

  const adjacent = `${repoDir}-worktrees`;
  const sibling = path.dirname(repoDir);

  const mode = (env.SHIP_DAG_WORKTREE_MODE || "").trim().toLowerCase();
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
  return /path:\s*"\.\.\//.test(source) ? sibling : adjacent;
}
