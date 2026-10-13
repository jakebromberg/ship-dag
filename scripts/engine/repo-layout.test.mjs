import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importCo } from '../lib/co-home.mjs';
import { layoutWorktreeHooks, repoDirName, worktreeModeOf, worktreeRootFor } from './repo-layout.mjs';

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
      isCheckoutRoot: () => true,
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
      isCheckoutRoot: () => true,
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
      isCheckoutRoot: () => true,
    }),
    'Wallpaper',
  );
});

test('skips linked worktrees that share the origin, and picks deterministically', () => {
  // Sibling worktrees of the checkout live in the same dir and carry its origin;
  // returning one of them would make every later hook treat it as the checkout.
  assert.equal(
    repoDirName('WXYC/wallpaper-ios', {
      reposDir: '/repos',
      existsSync: () => false,
      listDirs: () => ['Wallpaper--add-blur', 'Wallpaper', '2-fix-colors', 'Clone'],
      remoteOf: () => 'git@github.com:WXYC/wallpaper-ios.git',
      isCheckoutRoot: (dir) => dir === '/repos/Wallpaper' || dir === '/repos/Clone',
    }),
    'Clone',
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

for (const [name, manifest] of [
  ['a line comment', '// .package(name: "Analytics", path: "../Analytics")\n.package(url: "https://x.example/y.git", from: "1.0.0")'],
  ['a block comment', '/* .package(path: "../Analytics"), */ .package(url: "https://x.example/y.git", from: "1.0.0")'],
  ['a target path', '.target(name: "Thing", path: "../Sources/Thing")'],
  ['a nested block comment', '/* outer /* inner */ .package(path: "../Analytics") */ .package(url: "https://x.example/y.git", from: "1.0.0")'],
]) {
  test(`a ../ path in ${name} is not a sibling dependency`, () => {
    assert.equal(
      worktreeRootFor('/repos/Wallpaper', { existsSync: () => true, readFileSync: () => manifest, env: {} }),
      '/repos/Wallpaper-worktrees',
    );
  });
}

test('a path dependency after a URL on the same line is still detected', () => {
  assert.equal(
    worktreeRootFor('/repos/Wallpaper', {
      existsSync: () => true,
      readFileSync: () => '.package(url: "https://x.example/y.git", from: "1.0.0"), .package(path: "../Core")',
      env: {},
    }),
    '/repos',
  );
});

test('an unknown SHIP_DAG_WORKTREE_MODE warns once and falls back to detection', () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  assert.equal(worktreeModeOf({ SHIP_DAG_WORKTREE_MODE: 'siblings' }, warn), '');
  assert.equal(worktreeModeOf({ SHIP_DAG_WORKTREE_MODE: 'siblings' }, warn), '');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /SHIP_DAG_WORKTREE_MODE.*siblings/);
  assert.equal(worktreeModeOf({ SHIP_DAG_WORKTREE_MODE: ' Sibling ' }, warn), 'sibling');
  assert.equal(worktreeModeOf({}, warn), '');
  assert.equal(warnings.length, 1);
});

// ---------------------------------------- layoutWorktreeHooks, against real git

const here = dirname(fileURLToPath(import.meta.url));
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** A bare `remotes/<owner>/<repo>.git` with one commit holding `files`, cloned to `dest`. */
function cloneFixture(root, repo, dest, files) {
  const bare = join(root, 'remotes', `${repo}.git`);
  const seed = join(root, 'seed', repo);
  mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  for (const [name, body] of Object.entries(files)) writeFileSync(join(seed, name), body);
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'seed');
  mkdirSync(dirname(bare), { recursive: true });
  git(root, 'clone', '-q', '--bare', seed, bare);
  git(root, 'clone', '-q', bare, dest);
}

test('sibling worktrees are namespaced, never shadow the checkout, and keep their path for the run', async () => {
  const { deriveWorktreeHooks } = await importCo(process.env, ['deriveWorktreeHooks']);
  const root = join(here, '..', '..', '.test-scratch', `repo-layout-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  try {
    const shared = join(root, 'Shared');
    mkdirSync(shared, { recursive: true });
    cloneFixture(root, 'WXYC/Analytics', join(shared, 'Analytics'), { 'README': 'a' });
    cloneFixture(root, 'WXYC/wallpaper-ios', join(shared, 'Wallpaper'), {
      'Package.swift': '.package(name: "Analytics", path: "../Analytics")',
    });
    const issue = (slug) => ({ number: 1, slug, repo: 'WXYC/wallpaper-ios' });
    const hooks = layoutWorktreeHooks(deriveWorktreeHooks, { reposDir: shared, env: {} });

    for (const slug of ['2-fix-colors', 'analytics']) await hooks.setUpWorktree(issue(slug));
    const wt = hooks.getWorktreePath(issue('analytics'));
    assert.equal(wt, join(shared, 'Wallpaper--analytics'));
    assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'orchestrator/analytics');
    assert.equal(git(join(shared, 'Analytics'), 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');

    // A fresh resolver (a later process) still finds the checkout, not a worktree.
    assert.equal(repoDirName('WXYC/wallpaper-ios', { reposDir: shared }), 'Wallpaper');

    // The layout is fixed for the run even when the checkout's manifest changes.
    writeFileSync(join(shared, 'Wallpaper', 'Package.swift'), '// no path deps');
    assert.equal(hooks.getWorktreePath(issue('analytics')), wt);
    await hooks.removeWorktree(issue('analytics'));
    assert.equal(existsSync(wt), false);

    // A path that exists but is not this repo's worktree is refused, not reused.
    mkdirSync(join(shared, 'Wallpaper--stale'));
    await assert.rejects(hooks.setUpWorktree(issue('stale')), /not a worktree of/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a submodule under a superproject resolves, a plain superproject subdir never does, and a stale registration is skipped', async () => {
  const { deriveWorktreeHooks } = await importCo(process.env, ['deriveWorktreeHooks']);
  const root = join(here, '..', '..', '.test-scratch', `repo-layout-sub-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  try {
    const superDir = join(root, 'wxyc-ios-64');
    cloneFixture(root, 'WXYC/wxyc-ios-64', superDir, { 'README': 'super' });
    cloneFixture(root, 'WXYC/wallpaper-ios', join(root, 'unused'), {
      'Package.swift': '.package(name: "Notes", path: "../Notes")',
    });
    git(superDir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q',
      join(root, 'remotes', 'WXYC', 'wallpaper-ios.git'), 'Shared/Wallpaper');
    const shared = join(superDir, 'Shared');
    mkdirSync(join(shared, 'Notes'));
    writeFileSync(join(shared, 'Notes', 'README'), 'a plain directory of the superproject');

    // The superproject's own origin must not resolve to a plain subdirectory of it.
    assert.equal(repoDirName('WXYC/wxyc-ios-64', { reposDir: shared }), 'wxyc-ios-64');
    assert.equal(repoDirName('WXYC/wallpaper-ios', { reposDir: shared }), 'Wallpaper');

    const issue = (slug) => ({ number: 1, slug, repo: 'WXYC/wallpaper-ios' });
    const hooks = layoutWorktreeHooks(deriveWorktreeHooks, { reposDir: shared, env: {} });
    for (const slug of ['aaa-gone', 'analytics']) await hooks.setUpWorktree(issue(slug));
    const wt = hooks.getWorktreePath(issue('analytics'));
    assert.equal(wt, join(shared, 'Wallpaper--analytics'));

    // A registration whose dir was deleted by hand, listed before the target,
    // must not stop a leftover worktree from being reused.
    rmSync(hooks.getWorktreePath(issue('aaa-gone')), { recursive: true, force: true });
    await hooks.setUpWorktree(issue('analytics'));
    assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'orchestrator/analytics');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
