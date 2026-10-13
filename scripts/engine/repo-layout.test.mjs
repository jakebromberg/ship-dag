import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repoDirName, worktreeRootFor } from './repo-layout.mjs';

// Two assumptions deriveWorktreeHooks makes by default, both false for a repo
// vendored as a git submodule under a package directory:
//
//   1. the checkout directory is named after the repo (`WXYC/wallpaper-ios`
//      → `wallpaper-ios`), when the submodule path may be anything (`Wallpaper`);
//   2. worktrees can live in a sibling `<repoDir>-worktrees/` root, when a
//      package resolving dependencies through `../` needs its worktree to be a
//      SIBLING of the checkout or every path dependency misses.
//
// Both are overridable on deriveWorktreeHooks; these resolve what to pass.

// ---------------------------------------------------------------- repoDirName

test('uses the repo name when that directory exists (the ordinary org layout)', () => {
  assert.equal(
    repoDirName('WXYC/Backend-Service', {
      reposDir: '/repos',
      existsSync: (p) => p === '/repos/Backend-Service',
    }),
    'Backend-Service',
  );
});

test('falls back to the directory whose origin remote matches the repo', () => {
  assert.equal(
    repoDirName('WXYC/wallpaper-ios', {
      reposDir: '/repos',
      existsSync: (p) => p === '/repos/Wallpaper',
      listDirs: () => ['Analytics', 'Wallpaper', 'Core'],
      remoteOf: (dir) =>
        dir === '/repos/Wallpaper' ? 'git@github.com:WXYC/wallpaper-ios.git' : 'git@github.com:WXYC/other.git',
    }),
    'Wallpaper',
  );
});

test('matches a remote regardless of scheme, case, or .git suffix', () => {
  assert.equal(
    repoDirName('WXYC/wallpaper-ios', {
      reposDir: '/repos',
      existsSync: (p) => p === '/repos/Wallpaper',
      listDirs: () => ['Wallpaper'],
      remoteOf: () => 'https://github.com/wxyc/WALLPAPER-IOS',
    }),
    'Wallpaper',
  );
});

test('returns the literal repo name when nothing matches, so the engine still reports "not found"', () => {
  assert.equal(
    repoDirName('WXYC/ghost', {
      reposDir: '/repos',
      existsSync: () => false,
      listDirs: () => ['Analytics'],
      remoteOf: () => 'git@github.com:WXYC/Analytics.git',
    }),
    'ghost',
  );
});

test('a directory that is not a git checkout is skipped rather than throwing', () => {
  assert.equal(
    repoDirName('WXYC/wallpaper-ios', {
      reposDir: '/repos',
      existsSync: (p) => p === '/repos/Wallpaper',
      listDirs: () => ['build-output', 'Wallpaper'],
      remoteOf: (dir) => {
        if (dir === '/repos/build-output') throw new Error('not a git repository');
        return 'git@github.com:WXYC/wallpaper-ios.git';
      },
    }),
    'Wallpaper',
  );
});

// ------------------------------------------------------------ worktreeRootFor

test('defaults to the adjacent <repoDir>-worktrees root', () => {
  assert.equal(
    worktreeRootFor('/repos/Backend-Service', { existsSync: () => false, env: {} }),
    '/repos/Backend-Service-worktrees',
  );
});

test('a package with ../ path dependencies gets sibling worktrees instead', () => {
  // `/repos/Wallpaper/../Analytics` must stay resolvable from the worktree, so
  // the worktree has to be a direct child of the dir holding the siblings.
  assert.equal(
    worktreeRootFor('/repos/Wallpaper', {
      existsSync: (p) => p === '/repos/Wallpaper/Package.swift',
      readFileSync: () => 'dependencies: [ .package(name: "Analytics", path: "../Analytics") ]',
      env: {},
    }),
    '/repos',
  );
});

test('a Package.swift with only remote dependencies keeps the adjacent root', () => {
  assert.equal(
    worktreeRootFor('/repos/Lerpable', {
      existsSync: (p) => p === '/repos/Lerpable/Package.swift',
      readFileSync: () => 'dependencies: [ .package(url: "https://example.com/x.git", from: "1.0.0") ]',
      env: {},
    }),
    '/repos/Lerpable-worktrees',
  );
});

test('SHIP_DAG_WORKTREE_MODE=sibling forces sibling placement without detection', () => {
  assert.equal(
    worktreeRootFor('/repos/Thing', { existsSync: () => false, env: { SHIP_DAG_WORKTREE_MODE: 'sibling' } }),
    '/repos',
  );
});

test('SHIP_DAG_WORKTREE_MODE=adjacent overrides detection, for an escape hatch', () => {
  assert.equal(
    worktreeRootFor('/repos/Wallpaper', {
      existsSync: (p) => p === '/repos/Wallpaper/Package.swift',
      readFileSync: () => '.package(name: "Analytics", path: "../Analytics")',
      env: { SHIP_DAG_WORKTREE_MODE: 'adjacent' },
    }),
    '/repos/Wallpaper-worktrees',
  );
});

test('an unreadable Package.swift falls back to the adjacent root rather than throwing', () => {
  assert.equal(
    worktreeRootFor('/repos/Wallpaper', {
      existsSync: () => true,
      readFileSync: () => {
        throw new Error('EACCES');
      },
      env: {},
    }),
    '/repos/Wallpaper-worktrees',
  );
});
