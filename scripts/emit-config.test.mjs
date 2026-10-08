import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deriveSlug, buildConfig, unknownCiRepos, unknownComplexities } from './emit-config.mjs';
import { load as loadTuning } from './lib/tuning.mjs';

// A minimal well-formed spec the ready-wave hands the emitter.
function spec(overrides = {}) {
  return {
    name: 'ship-dag-run1',
    repo: 'WXYC/library-metadata-lookup',
    stateDir: '/state/run1',
    projectRoot: '/Users/jake/Developer/WXYC',
    promptTemplate: '/skill/scripts/engine/prompt.md',
    repos: {
      'WXYC/library-metadata-lookup': { baseBranch: 'main', commands: ['ruff check .', 'pytest -q'] },
    },
    issues: [
      { number: 924, repo: 'WXYC/library-metadata-lookup', title: 'Reserve bulk headroom', complexity: 'normal', digest: 'Cap the bulk concurrency env below the interactive lane.' },
    ],
    ...overrides,
  };
}

test('deriveSlug kebab-cases a title and truncates', () => {
  assert.equal(deriveSlug(1, 'Reserve Bulk Headroom'), 'reserve-bulk-headroom');
  assert.equal(deriveSlug(2, '  Fix: the (weird)  name!! '), 'fix-the-weird-name');
  // no trailing dash after truncation
  const long = deriveSlug(3, 'a'.repeat(80));
  assert.ok(long.length <= 50);
  assert.ok(!long.endsWith('-'));
});

test('deriveSlug falls back to issue-<number> when title is empty/unusable', () => {
  assert.equal(deriveSlug(42, ''), 'issue-42');
  assert.equal(deriveSlug(42, '   '), 'issue-42');
  assert.equal(deriveSlug(42, '!!!'), 'issue-42');
  assert.equal(deriveSlug(42, undefined), 'issue-42');
});

test('buildConfig sets the engine-invocation defaults', () => {
  const c = buildConfig(spec());
  assert.equal(c.name, 'ship-dag-run1');
  assert.equal(c.configDir, '/state/run1/state');
  assert.equal(c.worktreeDir, '/state/run1/worktrees');
  assert.equal(c.projectRoot, '/Users/jake/Developer/WXYC');
  assert.equal(c.promptTemplate, '/skill/scripts/engine/prompt.md');
  assert.equal(c.branchPrefix, 'orchestrator/');
  assert.equal(c.defaultRepo, 'WXYC/library-metadata-lookup');
  assert.equal(c.defaultModel, 'sonnet');
  assert.equal(c.baseBranch, 'main');
  assert.equal(c.stallTimeout, 1800);
  assert.deepEqual(c.retryOnCheckFailure, { maxRetries: 1 });
});

test('every issue in a ready wave gets dependsOn: [] (single wave, independent)', () => {
  const c = buildConfig(spec({
    issues: [
      { number: 1, repo: 'WXYC/library-metadata-lookup', digest: 'a' },
      { number: 2, repo: 'WXYC/library-metadata-lookup', digest: 'b' },
    ],
  }));
  for (const iss of c.issues) assert.deepEqual(iss.dependsOn, []);
});

test('per-issue fields: slug, description=digest, optional model/effort/complexity/extraDirs', () => {
  const c = buildConfig(spec({
    issues: [
      { number: 930, repo: 'WXYC/library-metadata-lookup', title: 'Bounded admission control', complexity: 'complex', model: 'opus', effort: 'high', digest: 'Add admission control.', extraDirs: ['../wxyc-shared'] },
    ],
  }));
  const iss = c.issues[0];
  assert.equal(iss.number, 930);
  assert.equal(iss.slug, 'bounded-admission-control');
  assert.equal(iss.repo, 'WXYC/library-metadata-lookup');
  assert.equal(iss.description, 'Add admission control.');
  assert.equal(iss.complexity, 'complex');
  assert.equal(iss.model, 'opus');
  assert.equal(iss.effort, 'high');
  assert.deepEqual(iss.extraDirs, ['../wxyc-shared']);
});

test('optional per-issue fields are omitted when unset (engine applies its defaults)', () => {
  const c = buildConfig(spec({
    issues: [{ number: 5, repo: 'WXYC/library-metadata-lookup', digest: 'x' }],
  }));
  const iss = c.issues[0];
  assert.ok(!('model' in iss));
  assert.ok(!('effort' in iss));
  assert.ok(!('complexity' in iss));
  assert.ok(!('extraDirs' in iss));
});

test('a missing digest degrades to a read-the-issue placeholder', () => {
  const c = buildConfig(spec({ issues: [{ number: 7, repo: 'WXYC/library-metadata-lookup' }] }));
  assert.match(c.issues[0].description, /issue/i);
});

test('a sourceEstimate appends a line budget to the description the implementer reads', () => {
  const c = buildConfig(spec({
    issues: [{ number: 924, repo: 'WXYC/library-metadata-lookup', digest: 'Cap the bulk concurrency env.', sourceEstimate: 120 }],
  }));
  const d = c.issues[0].description;
  assert.match(d, /Cap the bulk concurrency env\./); // the digest survives verbatim
  assert.match(d, /120/);
  assert.match(d, /production source/i);
});

test('the budget rides on the description even when triage produced no digest', () => {
  const c = buildConfig(spec({
    issues: [{ number: 7, repo: 'WXYC/library-metadata-lookup', sourceEstimate: 80 }],
  }));
  assert.match(c.issues[0].description, /issue/i);
  assert.match(c.issues[0].description, /80/);
});

test('no sourceEstimate leaves the description exactly as triage wrote it', () => {
  const c = buildConfig(spec());
  assert.equal(c.issues[0].description, 'Cap the bulk concurrency env below the interactive lane.');
});

test('a non-positive or non-numeric sourceEstimate is dropped, not emitted as a nonsense budget', () => {
  for (const bad of [0, -5, 'lots', null, NaN, undefined]) {
    const c = buildConfig(spec({
      issues: [{ number: 924, repo: 'WXYC/library-metadata-lookup', digest: 'Cap it.', sourceEstimate: bad }],
    }));
    assert.equal(c.issues[0].description, 'Cap it.', `sourceEstimate ${String(bad)} should be ignored`);
  }
});

test('sourceEstimate is folded into the description, never emitted as an engine issue field', () => {
  const c = buildConfig(spec({
    issues: [{ number: 924, repo: 'WXYC/library-metadata-lookup', digest: 'Cap it.', sourceEstimate: 120 }],
  }));
  assert.ok(!('sourceEstimate' in c.issues[0]));
});

test('repos: map is assembled from the distinct issue repos with per-repo base + CI', () => {
  const c = buildConfig(spec({
    repos: {
      'WXYC/library-metadata-lookup': { baseBranch: 'main', commands: ['pytest -q'] },
      'WXYC/wxyc-ios-64': { baseBranch: 'master', commands: ['xcodebuild test'] },
    },
    issues: [
      { number: 924, repo: 'WXYC/library-metadata-lookup', digest: 'a' },
      { number: 685, repo: 'WXYC/wxyc-ios-64', digest: 'b' },
    ],
  }));
  assert.deepEqual(Object.keys(c.repos).sort(), ['WXYC/library-metadata-lookup', 'WXYC/wxyc-ios-64']);
  assert.equal(c.repos['WXYC/wxyc-ios-64'].baseBranch, 'master');
  assert.deepEqual(c.repos['WXYC/wxyc-ios-64'].postSessionCheck, { commands: ['xcodebuild test'] });
});

test('repos: map never emits a key no issue references (engine unknownRepoKeys would throw)', () => {
  const c = buildConfig(spec({
    repos: {
      'WXYC/library-metadata-lookup': { baseBranch: 'main', commands: ['pytest -q'] },
      'WXYC/Backend-Service': { baseBranch: 'main', commands: ['npm run ci'] }, // no issue uses it
    },
    issues: [{ number: 924, repo: 'WXYC/library-metadata-lookup', digest: 'a' }],
  }));
  assert.ok(!('WXYC/Backend-Service' in c.repos));
});

test('an issue without its own repo falls back to the default repo', () => {
  const c = buildConfig(spec({
    issues: [{ number: 924, digest: 'a' }], // no repo
  }));
  assert.equal(c.issues[0].repo, 'WXYC/library-metadata-lookup');
  assert.ok('WXYC/library-metadata-lookup' in c.repos);
});

test('unknownCiRepos flags issue repos that have no CI profile', () => {
  const s = spec({
    repos: { 'WXYC/library-metadata-lookup': { baseBranch: 'main', commands: ['pytest -q'] } },
    issues: [
      { number: 924, repo: 'WXYC/library-metadata-lookup', digest: 'a' },
      { number: 1, repo: 'WXYC/some-new-repo', digest: 'b' }, // no profile
    ],
  });
  assert.deepEqual(unknownCiRepos(s), ['WXYC/some-new-repo']);
});

test('output serializes to valid JSON (which the YAML loader parses)', () => {
  const c = buildConfig(spec());
  const round = JSON.parse(JSON.stringify(c));
  assert.deepEqual(round, c);
});

// The bundled repo-ci-profiles.json must carry a real CI profile for every repo
// /ship-dag is expected to ship — otherwise emit-config warns and the wave lands
// unverified (no post-session check). This guards the daisyguide generalization:
// a spec built from the on-disk profile for daisysguide/backend must be
// fully-covered (unknownCiRepos empty) and carry executable post-session commands.
test('repo-ci-profiles.json makes daisysguide/backend a known-CI repo (no unverified wave)', () => {
  const profiles = JSON.parse(
    // Resolve relative to THIS file, not cwd — validation runs the suite via a
    // scripts/**/*.test.mjs glob whose working directory isn't guaranteed.
    readFileSync(new URL('../references/repo-ci-profiles.json', import.meta.url), 'utf-8'),
  ).profiles;
  const repo = 'daisysguide/backend';
  const s = spec({
    repo,
    repos: { [repo]: profiles[repo] },
    issues: [{ number: 397, repo, digest: 'revenuecat-webhook mapper' }],
  });
  assert.deepEqual(unknownCiRepos(s), []);
  const built = buildConfig(s).repos[repo];
  assert.equal(built.baseBranch, 'main');
  assert.ok(
    built.postSessionCheck?.commands?.length > 0,
    'daisysguide/backend must carry executable CI commands',
  );
});

// The daisysguide/ios profile was recovered from a clone whose object store had
// corrupted, so it never reached origin; these pin the parts that were learned
// the hard way and would be silently lossy to "simplify".
test('repo-ci-profiles.json makes daisysguide/ios a known-CI repo (no unverified wave)', () => {
  const profiles = JSON.parse(
    readFileSync(new URL('../references/repo-ci-profiles.json', import.meta.url), 'utf-8'),
  ).profiles;
  const repo = 'daisysguide/ios';
  const s = spec({
    repo,
    repos: { [repo]: profiles[repo] },
    issues: [{ number: 1, repo, digest: 'beta ship-dag run' }],
  });
  assert.deepEqual(unknownCiRepos(s), []);
  const built = buildConfig(s).repos[repo];
  assert.equal(built.baseBranch, 'main');
  assert.ok(
    built.postSessionCheck?.commands?.length > 0,
    'daisysguide/ios must carry executable CI commands',
  );
});

test('daisysguide/ios xcodebuild commands redirect their logs (execSync maxBuffer is 1 MiB)', () => {
  const { commands } = JSON.parse(
    readFileSync(new URL('../references/repo-ci-profiles.json', import.meta.url), 'utf-8'),
  ).profiles['daisysguide/ios'];
  const xcodebuild = commands.filter((c) => c.includes('xcodebuild'));
  assert.ok(xcodebuild.length > 0, 'expected xcodebuild commands');
  // An unredirected full-suite log blows execSync's default maxBuffer and every
  // node dies ENOBUFS *after* opening its PR — the failure the _note records.
  for (const c of xcodebuild) {
    assert.match(c, />\s*"\$\{TMPDIR:-\/tmp\}\//, `unredirected xcodebuild command: ${c.slice(0, 60)}`);
  }
});

test('daisysguide/ios runs the resolve-sim-udid guard suite with DGS_NO_REAP unset', () => {
  const { commands } = JSON.parse(
    readFileSync(new URL('../references/repo-ci-profiles.json', import.meta.url), 'utf-8'),
  ).profiles['daisysguide/ios'];
  // The run exports DGS_NO_REAP=1 for the resolver calls inside the xcodebuild
  // entries; the guard suite pins default-reaper behaviour from ambient env, so
  // with the var set 1 of its 79 tests fails and the check dies at command 2.
  const guard = commands.find((c) => c.includes('test_resolve_sim_udid.py'));
  assert.ok(guard, 'expected the resolve-sim-udid guard suite');
  assert.match(guard, /env -u DGS_NO_REAP/);
});

test('every profile carrying a node_modules wipe retries it (macOS re-creates .DS_Store mid-delete)', () => {
  const { profiles } = JSON.parse(
    readFileSync(new URL('../references/repo-ci-profiles.json', import.meta.url), 'utf-8'),
  );
  for (const [repo, profile] of Object.entries(profiles)) {
    for (const c of profile.commands ?? []) {
      if (!c.includes('rm -rf node_modules')) continue;
      // A single rm can lose the race with macOS re-creating .DS_Store inside a
      // subdir it has already walked; the bounded retry wins it.
      assert.match(c, /for i in 1 2 3; do/, `${repo}: unretried node_modules wipe`);
    }
  }
});

// Frozen snapshot of the engine's COMPLEXITY_EFFORT (claude-orchestrator src/model-effort.ts);
// ship-dag owns the policy now, so this is a snapshot, not a live pin.
const ENGINE_COMPLEXITY_EFFORT = { mechanical: 'low', normal: 'medium', complex: 'high' };

for (const [complexity, effort] of Object.entries(ENGINE_COMPLEXITY_EFFORT)) {
  test(`complexity ${complexity} is stamped with effort ${effort} from tuning.json`, () => {
    const c = buildConfig(spec({ issues: [{ number: 1, repo: 'WXYC/library-metadata-lookup', complexity, digest: 'x' }] }));
    assert.equal(c.issues[0].effort, effort);
  });
}

test('an issue\'s own effort wins over the tuning map', () => {
  const c = buildConfig(spec({ issues: [{ number: 1, repo: 'WXYC/library-metadata-lookup', complexity: 'mechanical', effort: 'xhigh', digest: 'x' }] }));
  assert.equal(c.issues[0].effort, 'xhigh');
});

// The default-tuning tests above can't tell a tuning-driven lookup from a hardcoded
// map identical to it; a non-default map can.
test('the effort follows the tuning argument, not a hardcoded map', () => {
  const tuning = { ...loadTuning(), implement: { mechanical: 'xhigh', normal: 'xhigh', complex: 'max' } };
  const issues = ['mechanical', 'complex'].map((complexity, i) => ({ number: i + 1, repo: 'WXYC/library-metadata-lookup', complexity, digest: 'x' }));
  const c = buildConfig(spec({ issues }), tuning);
  assert.deepEqual(c.issues.map((i) => i.effort), ['xhigh', 'max']);
});

// An out-of-enum complexity (including an inherited Object.prototype key) is dropped
// along with its effort — the engine's schema rejects the whole config on an unknown
// complexity — so the engine default applies, and it is named for the stderr warning.
for (const complexity of ['__proto__', 'constructor', 'toString', 'Complex', 'normal.length', ['normal']]) {
  test(`out-of-enum complexity ${complexity} emits no complexity or effort and is reported`, () => {
    const s = spec({ issues: [{ number: 1, repo: 'WXYC/library-metadata-lookup', complexity, digest: 'x' }] });
    const iss = buildConfig(s).issues[0];
    assert.ok(!('effort' in iss) && !('complexity' in iss));
    assert.deepEqual(unknownComplexities(s), [{ number: 1, complexity }]);
  });
}

test('in-enum and absent complexities are not reported', () => {
  const issues = [{ number: 1, complexity: 'normal' }, { number: 2 }].map((i) => ({ ...i, repo: 'WXYC/library-metadata-lookup', digest: 'x' }));
  assert.deepEqual(unknownComplexities(spec({ issues })), []);
});

test('the CLI warns on stderr about an out-of-enum complexity and emits no complexity or effort', () => {
  const s = spec({ issues: [{ number: 7, repo: 'WXYC/library-metadata-lookup', complexity: 'Complex', digest: 'x' }] });
  const cli = fileURLToPath(new URL('./emit-config.mjs', import.meta.url));
  const r = spawnSync('node', [cli, '-'], { input: JSON.stringify(s), encoding: 'utf-8' });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /unknown complexity.*#7 \(Complex\)/);
  const iss = JSON.parse(r.stdout).issues[0];
  assert.ok(!('effort' in iss) && !('complexity' in iss));
});

test('an out-of-enum complexity keeps the issue\'s own effort, and the warning does not claim it was dropped', () => {
  const s = spec({ issues: [{ number: 2, repo: 'WXYC/library-metadata-lookup', complexity: 'Complex', effort: 'high', digest: 'x' }] });
  const cli = fileURLToPath(new URL('./emit-config.mjs', import.meta.url));
  const r = spawnSync('node', [cli, '-'], { input: JSON.stringify(s), encoding: 'utf-8' });
  assert.equal(JSON.parse(r.stdout).issues[0].effort, 'high');
  assert.match(r.stderr, /#2 \(Complex\)/);
  assert.doesNotMatch(r.stderr, /effort dropped/i);
});
