import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realRunGh } from './lib/gh.mjs';
import { deriveSlug, buildConfig, buildConfigsByHost, unknownCiRepos, unknownComplexities, validateSpec, ghReadRef } from './emit-config.mjs';
import { load as loadTuning } from './lib/tuning.mjs';
import { waveSidecar } from './lib/wave-sidecar.mjs';
import { validateHosts } from './lib/hosts.mjs';

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

// Triage's `decisions` ride on the description too, so the implementer gets the decisions the
// review enforces. The heading, the digest before it and the line budget after it are all pinned.
const DECISIONS_HEADING = 'Settled decisions (binding; they override the issue body where they differ):';

test('decisions are folded into the description after the digest and before the line budget, one per line', () => {
  const c = buildConfig(spec({
    issues: [{ number: 924, repo: 'WXYC/library-metadata-lookup', digest: 'Cap the bulk concurrency env.', decisions: ['A', 'B'], sourceEstimate: 120 }],
  }));
  const d = c.issues[0].description;
  assert.ok(d.startsWith(`Cap the bulk concurrency env.\n\n${DECISIONS_HEADING}\n- A\n- B\n\nSize budget: about 120 `), d);
});

test('decisions fold into the description when there is no line budget, and when triage produced no digest', () => {
  const noBudget = buildConfig(spec({
    issues: [{ number: 924, repo: 'WXYC/library-metadata-lookup', digest: 'Cap it.', decisions: ['A'] }],
  }));
  assert.equal(noBudget.issues[0].description, `Cap it.\n\n${DECISIONS_HEADING}\n- A`);
  const noDigest = buildConfig(spec({
    issues: [{ number: 7, repo: 'WXYC/library-metadata-lookup', decisions: ['A'] }],
  }));
  assert.match(noDigest.issues[0].description, /^See the GitHub issue .*\n\nSettled decisions/);
});

// Absent, null, empty and all-blank decisions leave the description byte-identical to what it was
// before decisions existed. The expected strings are literals, so no row compares the code under
// test with itself.
const TODAY_PLAIN = 'Cap it.';
const TODAY_BUDGETED = 'Cap it.\n\nSize budget: about 120 added lines of production source. Tests, generated data, and docs sit outside the budget — do not trim them to fit. If the change runs more than half again past it, stop at the last green, coherent point and push that.';
for (const decisions of [undefined, null, [], ['', '  ']]) {
  test(`decisions ${JSON.stringify(decisions) ?? 'absent'} leave the description exactly as today's`, () => {
    for (const [sourceEstimate, expected] of [[undefined, TODAY_PLAIN], [120, TODAY_BUDGETED]]) {
      const issue = { number: 924, repo: 'WXYC/library-metadata-lookup', digest: 'Cap it.', sourceEstimate, decisions };
      assert.equal(buildConfig(spec({ issues: [issue] })).issues[0].description, expected);
    }
  });
}

test('a decision is kept verbatim', () => {
  const verbatim = 'The dialog line is "It goes on the review shelf." — not the body\'s older one (see #3382); 30 days, not all rows';
  const c = buildConfig(spec({
    issues: [{ number: 924, repo: 'WXYC/library-metadata-lookup', digest: 'x', decisions: [verbatim] }],
  }));
  assert.equal(c.issues[0].description, `x\n\n${DECISIONS_HEADING}\n- ${verbatim}`);
});

// One decision is always one list item: every line break (LF, CRLF, a lone CR, U+2028, U+2029)
// and the whitespace around it folds to one space, and the ends are trimmed.
for (const [name, raw, folded] of [
  ['LF', 'first\nsecond', 'first second'],
  ['CRLF with a list marker', 'first\r\n- second', 'first - second'],
  ['a lone CR', 'c\r- d', 'c - d'],
  ['U+2028', 'c\u2028- d', 'c - d'],
  ['U+2029', 'c\u2029- d', 'c - d'],
  ['a run of mixed breaks and spaces', 'a \r\n \u2028\n b', 'a b'],
  ['leading and trailing whitespace', '  padded \n', 'padded'],
]) {
  test(`a decision with ${name} stays one list item`, () => {
    const c = buildConfig(spec({
      issues: [{ number: 924, repo: 'WXYC/library-metadata-lookup', digest: 'x', decisions: [raw, 'next'] }],
    }));
    assert.equal(c.issues[0].description, `x\n\n${DECISIONS_HEADING}\n- ${folded}\n- next`);
  });
}

// The engine prompt interpolates the description under "Implementation plan from triage", and its
// step 2 tells the implementer how far to trust that plan against the issue body.
test("prompt.md step 2 does not send the implementer back to the issue body over a listed settled decision", () => {
  const prompt = readFileSync(fileURLToPath(new URL('./engine/prompt.md', import.meta.url)), 'utf8');
  const step2 = prompt.split('\n').find((l) => l.startsWith('2. '));
  assert.match(step2, /scope and acceptance criteria/);
  assert.match(step2, /listed settled decision differs from the issue body, the decision overrides it\./);
});

test('the sidecar records decisions exactly as the spec gave them, and the config carries them only in the description', () => {
  const decisions = ['use JSONL', 'no new dep'];
  const s = spec({ issues: [{ number: 924, repo: 'WXYC/library-metadata-lookup', digest: 'x', decisions }] });
  const c = buildConfig(s);
  assert.ok(!('decisions' in c.issues[0]));
  assert.deepEqual(waveSidecar(s, { config: c }).issues[0].decisions, decisions);
  assert.deepEqual(s.issues[0].decisions, ['use JSONL', 'no new dep']); // the spec is not mutated
  assert.doesNotMatch(JSON.stringify(waveSidecar(s, { config: c })), /Settled decisions/);
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

// An out-of-enum complexity (including an inherited Object.prototype key) fails loudly:
// silently running the issue at the default effort could under-power it, and before
// tuning.json the engine rejected such a config outright.
for (const complexity of ['__proto__', 'constructor', 'toString', 'Complex', 'normal.length', ['normal']]) {
  test(`out-of-enum complexity ${complexity} is reported and refused`, () => {
    const s = spec({ issues: [{ number: 1, repo: 'WXYC/library-metadata-lookup', complexity, digest: 'x' }] });
    assert.deepEqual(unknownComplexities(s), [{ number: 1, ref: 'WXYC/library-metadata-lookup#1', complexity }]);
    assert.throws(() => buildConfig(s), /unknown complexity.*WXYC\/library-metadata-lookup#1/);
  });
}

test('in-enum and absent complexities are not reported', () => {
  const issues = [{ number: 1, complexity: 'normal' }, { number: 2 }].map((i) => ({ ...i, repo: 'WXYC/library-metadata-lookup', digest: 'x' }));
  assert.deepEqual(unknownComplexities(spec({ issues })), []);
});

// Every invalid-spec refusal, as one table. To add a rule (e.g. W3's unknown reach), add a row.
// `mustName` are the issue or value each refusal must name on stderr.
const REFUSALS = [
  ['an out-of-enum complexity', { issues: [{ number: 7, complexity: 'Complex' }] }, [/unknown complexity.*WXYC\/library-metadata-lookup#7 \(Complex\)/]],
  ['an out-of-enum complexity even when the issue sets its own effort', { issues: [{ number: 7, complexity: 'Complex', effort: 'high' }] }, [/unknown complexity.*WXYC\/library-metadata-lookup#7 \(Complex\)/]],
  ['an unknown blockOn category', { blockOn: 'corectness' }, [/corectness/]],
  ['a blockOn of the wrong type', { blockOn: 5 }, [/blockOn.*5/]],
  ['an unknown reach', { issues: [{ number: 7, reach: 'galaxy' }] }, [/unknown reach.*WXYC\/library-metadata-lookup#7 \("galaxy"\)/]],
  ['an array reach, printed as its JSON', { issues: [{ number: 7, reach: ['repo'] }] }, [/unknown reach.*WXYC\/library-metadata-lookup#7 \(\["repo"\]\)/]],
  ['an inherited-key reach', { issues: [{ number: 7, reach: 'constructor' }] }, [/unknown reach.*WXYC\/library-metadata-lookup#7 \("constructor"\)/]],
  ['decisions as a string', { issues: [{ number: 7, decisions: 'use JSONL' }] }, [/decisions.*WXYC\/library-metadata-lookup#7/]],
  ['decisions with a non-string element', { issues: [{ number: 7, decisions: ['ok', 3] }] }, [/decisions.*WXYC\/library-metadata-lookup#7/]],
  ['an unknown complexity and an invalid blockOn together', { issues: [{ number: 7, complexity: 'Complex' }], blockOn: 'corectness' }, [/WXYC\/library-metadata-lookup#7 \(Complex\)/, /corectness/]],
  // The valid #7 comes first and lives in the spec's own repo, so a lookup by number
  // or a hardcoded spec.repo would name the wrong issue and turn these rows red.
  ['an invalid complexity sharing its number with a valid issue in another repo', { issues: [{ number: 7, complexity: 'normal' }, { number: 7, repo: 'WXYC/wxyc-ios-64', complexity: 'Complex' }] }, [/unknown complexity on WXYC\/wxyc-ios-64#7 \(Complex\); /]],
  ['an invalid reach sharing its number with a valid issue in another repo', { issues: [{ number: 7, reach: 'repo' }, { number: 7, repo: 'WXYC/wxyc-ios-64', reach: 'galaxy' }] }, [/unknown reach on WXYC\/wxyc-ios-64#7 \("galaxy"\); /]],
  ['invalid decisions sharing a number with a valid issue in another repo', { issues: [{ number: 7, decisions: [] }, { number: 7, repo: 'WXYC/wxyc-ios-64', decisions: 'x' }] }, [/decisions must be an array of strings on WXYC\/wxyc-ios-64#7\./]],
];

for (const [name, overrides, mustName] of REFUSALS) {
  const issues = overrides.issues?.map((i) => ({ repo: 'WXYC/library-metadata-lookup', digest: 'x', ...i }));
  const refused = spec({ ...overrides, ...(issues && { issues }) });

  test(`validateSpec and buildConfig refuse ${name}`, () => {
    for (const m of mustName) {
      assert.throws(() => validateSpec(refused), m);
      assert.throws(() => buildConfig(refused), m);
    }
  });

  test(`the CLI exits 2 on ${name}, names it, emits no config and writes no sidecar`, () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'emit-config-'));
    const cli = fileURLToPath(new URL('./emit-config.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [cli, '-'], { input: JSON.stringify({ ...refused, stateDir }), encoding: 'utf-8' });
    assert.equal(r.status, 2);
    for (const m of mustName) assert.match(r.stderr, m);
    assert.equal(r.stdout, '');
    assert.deepEqual(readdirSync(stateDir), []);
  });
}

test('validateSpec accepts a valid reach and decisions, and their absence (null counts as absent, like complexity)', () => {
  const issues = [
    { number: 1, reach: 'repo', decisions: ['use JSONL', 'no new dep'] },
    { number: 2, reach: 'in-diff', decisions: [] },
    { number: 3 },
    { number: 4, reach: null, decisions: null },
  ].map((i) => ({ ...i, repo: 'WXYC/library-metadata-lookup', digest: 'x' }));
  validateSpec(spec({ issues }));
});

test('validateSpec accepts a valid spec, with or without a blockOn', () => {
  validateSpec(spec());
  validateSpec(spec({ blockOn: ['correctness', 'security'] }));
});

// An issue with no complexity takes the engine's config-level default, and that default
// comes from tuning.json too, so the engine path and the Workflow fallback read one file.
test('the config-level defaultEffort follows tuning.implement.normal', () => {
  const issues = [{ number: 1, repo: 'WXYC/library-metadata-lookup', digest: 'x' }];
  assert.equal(buildConfig(spec({ issues })).defaultEffort, loadTuning().implement.normal);
  const tuning = { ...loadTuning(), implement: { mechanical: 'low', normal: 'xhigh', complex: 'max' } };
  const c = buildConfig(spec({ issues }), tuning);
  assert.equal(c.defaultEffort, 'xhigh');
  assert.ok(!('effort' in c.issues[0]), 'the issue itself still carries no effort');
});

// ci-profile.mjs prints each repo as { baseBranch, commands, source }; the spec takes that map as its `repos`.
test("a repo whose CI is its own scripts/ci gets that post-session check, and ci-profile's source stays out of the config", () => {
  const repo = 'o/declared';
  const s = spec({ repo, repos: { [repo]: { baseBranch: 'main', commands: ['scripts/ci'], source: 'repo' } }, issues: [{ number: 1, repo, digest: 'x' }] });
  assert.deepEqual(unknownCiRepos(s), []);
  assert.deepEqual(buildConfig(s).repos[repo], { baseBranch: 'main', postSessionCheck: { commands: ['scripts/ci'] } });
});

test('the unverified-repo warning names both remedies: the repo declaring scripts/ci, or a registry entry', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'emit-config-'));
  const cli = fileURLToPath(new URL('./emit-config.mjs', import.meta.url));
  const repo = 'o/bare';
  const bare = spec({ stateDir, repo, repos: { [repo]: { baseBranch: 'main', commands: [], source: 'none' } }, issues: [{ number: 1, repo, digest: 'x' }] });
  const r = spawnSync(process.execPath, [cli, '-'], { input: JSON.stringify(bare), encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARNING — no CI profile for 1 repo\(s\): o\/bare\./);
  assert.match(r.stderr, /executable scripts\/ci/);
  assert.match(r.stderr, /references\/repo-ci-profiles\.json/);
});

// ---- hosts: --by-host splits the wave into one config per host ---------

const BOX = validateHosts({ box: { ssh: 'box', home: '/Users/jake', reposDir: '/Users/jake/Developer', sdHome: '/Users/jake/Developer/ship-dag', toolchains: ['node', 'python'] } });
const NODE_REPO = 'o/web';
const XCODE_REPO = 'o/ios';
const OPAQUE_REPO = 'o/opaque';
const hostSpec = (repos, issues) => spec({
  stateDir: '/state/ship-dag/engine/run1',
  repo: NODE_REPO,
  repos: {
    [NODE_REPO]: { baseBranch: 'main', commands: ['npm test'], ...repos[NODE_REPO] },
    [XCODE_REPO]: { baseBranch: 'main', commands: ['xcodebuild test -scheme A'], ...repos[XCODE_REPO] },
    [OPAQUE_REPO]: { baseBranch: 'main', commands: ['scripts/ci'], ...repos[OPAQUE_REPO] },
  },
  issues: issues.map((i) => ({ digest: 'x', repo: NODE_REPO, ...i })),
});

// [name, spec, hosts, expected hosts → issue numbers (in order) or a thrown message, expected warnings]
for (const [name, s, hosts, expected, warnings = []] of [
  ['no hosts and no host fields: one local config', hostSpec({}, [{ number: 1 }, { number: 2, repo: XCODE_REPO }]), {}, { local: [1, 2] }],
  ['a repo assigned to a host', hostSpec({ [NODE_REPO]: { host: 'box' } }, [{ number: 1 }, { number: 2, repo: XCODE_REPO }]), BOX, { box: [1], local: [2] }],
  ['a per-issue override beats the repo', hostSpec({ [NODE_REPO]: { host: 'box' } }, [{ number: 1, host: 'local' }, { number: 2 }]), BOX, { local: [1], box: [2] }],
  ['an issue overrides a local repo onto a host', hostSpec({}, [{ number: 1, host: 'box' }]), BOX, { box: [1] }],
  ['the toolchain guard keeps an Xcode repo local, with a warning', hostSpec({ [XCODE_REPO]: { host: 'box' } }, [{ number: 2, repo: XCODE_REPO }]), BOX, { local: [2] }, [/o\/ios#2 stays on local: host box lacks the xcode toolchain/]],
  ['declared toolchains win over the commands', hostSpec({ [XCODE_REPO]: { host: 'box', toolchains: ['node'] } }, [{ number: 2, repo: XCODE_REPO }]), BOX, { box: [2] }],
  ['an unrecognized command keeps a repo-assigned issue local, with a warning', hostSpec({ [OPAQUE_REPO]: { host: 'box' } }, [{ number: 3, repo: OPAQUE_REPO }]), BOX, { local: [3] }, [/o\/opaque#3 stays on local: .*"scripts\/ci"/]],
  ['an explicit host lacking a toolchain is refused', hostSpec({}, [{ number: 2, repo: XCODE_REPO, host: 'box' }]), BOX, /host box on o\/ios#2 lacks the xcode toolchain/],
  ['an unknown host is refused, naming the issue', hostSpec({ [NODE_REPO]: { host: 'nope' } }, [{ number: 1 }]), BOX, /unknown host "nope" on o\/web#1; known: local\/box/],
]) {
  test(`buildConfigsByHost: ${name}`, () => {
    const warned = [];
    const run = () => buildConfigsByHost(s, hosts, loadTuning(), { warn: (m) => warned.push(m) });
    if (expected instanceof RegExp) return assert.throws(run, expected);
    const out = run();
    assert.deepEqual(Object.fromEntries(out.map((c) => [c.host, c.config.issues.map((i) => i.number)])), expected);
    assert.equal(warned.length, warnings.length, warned.join('\n'));
    warnings.forEach((w, i) => assert.match(warned[i], w));
    // The engine config stays host-free.
    assert.ok(!JSON.stringify(out.map((c) => c.config)).includes('"host"'));
  });
}

test('buildConfigsByHost: with no hosts the one local config is exactly what buildConfig gives', () => {
  const s = hostSpec({}, [{ number: 1 }, { number: 2, repo: XCODE_REPO }]);
  const [only, ...rest] = buildConfigsByHost(s, {});
  assert.equal(rest.length, 0);
  assert.equal(JSON.stringify(only.config), JSON.stringify(buildConfig(s)));
});

test("buildConfigsByHost: a remote host's config takes its paths from the registry, the local config keeps the spec's", () => {
  const s = hostSpec({ [NODE_REPO]: { host: 'box' } }, [{ number: 1 }, { number: 2, repo: XCODE_REPO }]);
  const { box, local } = Object.fromEntries(buildConfigsByHost(s, BOX).map((c) => [c.host, c.config]));
  assert.equal(box.configDir, '/Users/jake/.local/state/ship-dag/engine/run1/state');
  assert.equal(box.worktreeDir, '/Users/jake/.local/state/ship-dag/engine/run1/worktrees');
  assert.equal(box.projectRoot, '/Users/jake/Developer');
  assert.equal(box.promptTemplate, '/Users/jake/Developer/ship-dag/scripts/engine/prompt.md');
  assert.deepEqual(Object.keys(box.repos), [NODE_REPO]);
  assert.deepEqual([local.configDir, local.worktreeDir, local.projectRoot, local.promptTemplate], ['/state/ship-dag/engine/run1/state', '/state/ship-dag/engine/run1/worktrees', '/Users/jake/Developer/WXYC', '/skill/scripts/engine/prompt.md']);
  assert.deepEqual(Object.keys(local.repos), [XCODE_REPO]);
});

test('the CLI --by-host writes config.local.json byte-identical to the plain output, and one sidecar line per host', () => {
  const stateDir = join(mkdtempSync(join(tmpdir(), 'emit-config-')), 'ship-dag', 'engine', 'run1');
  const outDir = join(mkdtempSync(join(tmpdir(), 'emit-config-')), 'out');
  const cli = fileURLToPath(new URL('./emit-config.mjs', import.meta.url));
  const input = JSON.stringify(hostSpec({}, [{ number: 1 }]), null, 0).replace('/state/ship-dag/engine/run1', stateDir);
  const plain = spawnSync(process.execPath, [cli, '-'], { input, encoding: 'utf-8' });
  const split = spawnSync(process.execPath, [cli, '-', '--by-host', outDir], { input, encoding: 'utf-8' });
  assert.equal(split.status, 0, split.stderr);
  assert.equal(split.stdout, `${join(outDir, 'config.local.json')}\n`);
  assert.equal(readFileSync(join(outDir, 'config.local.json'), 'utf-8'), plain.stdout);
  assert.equal(readFileSync(join(stateDir, 'ship-dag-wave.jsonl'), 'utf-8').trim().split('\n').length, 2);
});

test('only --by-host sidecar lines carry the host that runs them', () => {
  const sidecar = (...extra) => {
    const stateDir = join(mkdtempSync(join(tmpdir(), 'emit-config-')), 'ship-dag', 'engine', 'run1');
    const cli = fileURLToPath(new URL('./emit-config.mjs', import.meta.url));
    const input = JSON.stringify(hostSpec({}, [{ number: 1 }])).replace('/state/ship-dag/engine/run1', stateDir);
    const r = spawnSync(process.execPath, [cli, '-', ...extra], { input, encoding: 'utf-8' });
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(join(stateDir, 'ship-dag-wave.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  };
  assert.deepEqual(sidecar().map((e) => e.host), [undefined]);
  assert.deepEqual(sidecar('--by-host', join(mkdtempSync(join(tmpdir(), 'emit-config-')), 'out')).map((e) => e.host), ['local']);
});

test('the CLI --by-host exits 2 on a host the registry does not list, naming the issue, and writes nothing', () => {
  const outDir = join(mkdtempSync(join(tmpdir(), 'emit-config-')), 'out');
  const cli = fileURLToPath(new URL('./emit-config.mjs', import.meta.url));
  const input = JSON.stringify(hostSpec({}, [{ number: 1, host: 'nope' }]));
  const r = spawnSync(process.execPath, [cli, '-', '--by-host', outDir], { input, encoding: 'utf-8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown host "nope" on o\/web#1/);
  assert.equal(r.stdout, '');
  assert.throws(() => readdirSync(outDir), /ENOENT/);
});

test('the CLI exits 2 when --by-host has no directory', () => {
  const cli = fileURLToPath(new URL('./emit-config.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [cli, '-', '--by-host'], { input: '{}', encoding: 'utf-8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--by-host requires a value/);
});

// ---- merged since triage ------------------------------------------------

const R = 'WXYC/library-metadata-lookup';
const TRIAGED = '2026-10-16T12:00:00Z';
const sinceSpec = (digest, extra = {}) => spec({ issues: [{ number: 924, repo: R, digest, triagedAt: TRIAGED, ...extra }] });
const stubReader = (table) => {
  const calls = [];
  const readRef = (repo, number) => {
    calls.push(`${repo}#${number}`);
    const row = table[`${repo}#${number}`];
    if (row instanceof Error) throw row;
    return row;
  };
  return { readRef, calls };
};
const merged = (title, at = '2026-10-17T00:00:00Z') => ({ state: 'closed', title, closed_at: at, pull_request: { merged_at: at } });
const SETTLED = 'Conditionals in the plan that name a merged or closed one are settled. Read each file the plan names on `origin/main` before editing it.';

test('a ref the digest names that merged or closed since triage is prepended as a fact; other refs and the digest stay as written', () => {
  const { readRef, calls } = stubReader({
    [`${R}#2299`]: merged('Add the thing'),
    [`${R}#2003`]: { state: 'closed', title: 'Old', closed_at: '2026-10-18T00:00:00Z' },
    [`${R}#55`]: { state: 'open', title: 'Still open' },
    'WXYC/dj-site#7': merged('Other repo'),
  });
  const c = buildConfig(sinceSpec('Do X after #2299 (and #2299 again, and wxyc/library-metadata-lookup#2299), if #2003 lands, see #55 and WXYC/dj-site#7.'), loadTuning(), { readRef });
  assert.equal(c.issues[0].description, [
    `Since this plan was written: #2299 merged (Add the thing); #2003 closed; WXYC/dj-site#7 merged (Other repo). ${SETTLED}`,
    '',
    'Do X after #2299 (and #2299 again, and wxyc/library-metadata-lookup#2299), if #2003 lands, see #55 and WXYC/dj-site#7.',
  ].join('\n'));
  assert.deepEqual(calls.sort(), [`${R}#2003`, `${R}#2299`, `${R}#55`, 'WXYC/dj-site#7'].sort());
});

test('a PR closed without merging is reported as closed, never merged', () => {
  const { readRef } = stubReader({ [`${R}#66`]: { state: 'closed', title: 'Abandoned', closed_at: '2026-10-17T00:00:00Z', pull_request: { merged_at: null } } });
  const d = buildConfig(sinceSpec('See #66.'), loadTuning(), { readRef }).issues[0].description;
  assert.match(d, /^Since this plan was written: #66 closed\. /);
  assert.ok(!d.includes('#66 merged'));
});

test('the issue\'s decisions are scanned too, and the block precedes the decisions and budget', () => {
  const { readRef } = stubReader({ [`${R}#99`]: merged('Nine') });
  const d = buildConfig(sinceSpec('Plan.', { decisions: ['Follow #99'], sourceEstimate: 50 }), loadTuning(), { readRef }).issues[0].description;
  assert.match(d, /^Since this plan was written: #99 merged \(Nine\)\..*\n\nPlan\.\n\nSettled decisions/s);
});

// Each case must leave the description exactly the digest, with no reader call where none is due.
for (const [name, digest, extra, table, withReader, reads] of [
  ['nothing changed since triage', 'See #55 and #66.', {}, { [`${R}#55`]: { state: 'open', title: 'a' }, [`${R}#66`]: merged('b', '2026-10-01T00:00:00Z') }, true, 2],
  ['the digest names no refs', 'No refs here, v1.2#x.', {}, {}, true, 0],
  ['the issue names only itself', 'Part of #924.', {}, {}, true, 0],
  ['triage recorded no triagedAt', 'See #55.', { triagedAt: undefined }, { [`${R}#55`]: merged('a') }, true, 0],
  ['no reader is supplied', 'See #55.', {}, {}, false, 0],
]) {
  test(`unchanged description when ${name}`, () => {
    const { readRef, calls } = stubReader(table);
    const got = buildConfig(sinceSpec(digest, extra), loadTuning(), withReader ? { readRef } : undefined);
    assert.equal(got.issues[0].description, digest);
    assert.equal(calls.length, reads);
  });
}

// Text that looks like a ref and is not one: no read, no note, even when such an issue number exists and closed.
for (const [what, text] of [
  ['a 3-digit hex colour', 'Set the border to #333.'],
  ['a repeated-digit colour', 'Use #000 for text.'],
  ['a 6-digit hex colour', 'Fill is #123456.'],
  ['an 8-digit hex colour', 'Fill is #12345678.'],
  ['a line anchor', 'See file.ts#L42.'],
  ['a URL anchor', 'See https://example.com/page#42 for details.'],
  ['a GitHub URL anchor', 'See https://github.com/o/r/pull/5#discussion_r1 and https://github.com/o/r/issues/7#42.'],
  ['a path with an anchor', 'See docs/a/b/c#3.'],
  ['an ordinal', 'That is the #1 cause.'],
]) {
  test(`${what} is not scanned as a ref`, () => {
    const everything = new Proxy({}, { get: () => merged('Anything') });
    const calls = [];
    const readRef = (repo, number) => { calls.push(`${repo}#${number}`); return everything[`${repo}#${number}`]; };
    assert.equal(buildConfig(sinceSpec(text), loadTuning(), { readRef }).issues[0].description, text);
    assert.deepEqual(calls, []);
  });
}

// An owner/repo#N is never a colour, an ordinal or an anchor, whatever its number looks like.
for (const [what, text, repo, number] of [
  ['a repeated-digit number', 'If WXYC/dj-site#333 lands first, reuse its hook.', 'WXYC/dj-site', 333],
  ['a zero-run number', 'Needs WXYC/dj-site#000.', 'WXYC/dj-site', 0],
  ['a 6-digit number', 'Needs WXYC/media-worker#123456.', 'WXYC/media-worker', 123456],
  ['an 8-digit number', 'Needs o/r#12345678.', 'o/r', 12345678],
  ['a single-digit number', 'Needs WXYC/media-worker#3.', 'WXYC/media-worker', 3],
  ['an ordinary number', 'Needs WXYC/dj-site#2253.', 'WXYC/dj-site', 2253],
]) {
  test(`an owner-qualified ref with ${what} is read and noted`, () => {
    const { readRef, calls } = stubReader({ [`${repo}#${number}`]: merged('Landed') });
    const d = buildConfig(sinceSpec(text), loadTuning(), { readRef }).issues[0].description;
    assert.deepEqual(calls, [`${repo}#${number}`]);
    assert.match(d, new RegExp(`^Since this plan was written: ${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#${number} merged \\(Landed\\)\\.`));
  });
}

// Every bare #N is read against the issue's own repo, whatever word comes before it: a repo name, an acronym, or a
// relation word like "follow-up" can each precede a sibling ref, and a skipped sibling is a silent miss. Only an
// owner-less `repo#N` with no space is skipped (the lookbehind), as is a bare #N inside a URL or path anchor.
for (const [text, reads] of [
  ['After dj-site #55 merges.', [`${R}#55`]],
  ['Reuse the parser from follow-up #55.', [`${R}#55`]],
  ['Tracked in the sub-issue #55.', [`${R}#55`]],
  ['This is blocked-by #55.', [`${R}#55`]],
  ['Wait for CI #55.', [`${R}#55`]],
  ['The API #55 lands first.', [`${R}#55`]],
  ['Ask the DJ #55.', [`${R}#55`]],
  ['After PR #55 merges.', [`${R}#55`]],
  ['After issue #55 merges.', [`${R}#55`]],
  ['See library-metadata-lookup #55.', [`${R}#55`]],
  ['Done in this sentence. #55 too.', [`${R}#55`]],
  ['After dj-site#55 merges.', []],
]) {
  test(`a bare #N after a word: "${text}"`, () => {
    const { readRef, calls } = stubReader({ [`${R}#55`]: merged('Fifty-five') });
    buildConfig(sinceSpec(text), loadTuning(), { readRef });
    assert.deepEqual(calls, reads);
  });
}

test('a failed read names the ref as state unknown, warns, and still emits', () => {
  const { readRef } = stubReader({ [`${R}#55`]: new Error('boom') });
  const warnings = [];
  const d = buildConfig(sinceSpec('See #55.'), loadTuning(), { readRef, warn: (m) => warnings.push(m) }).issues[0].description;
  assert.equal(d, `Since this plan was written: #55 state unknown. Read each file the plan names on \`origin/main\` before editing it.\n\nSee #55.`);
  assert.match(warnings.join(), /WXYC\/library-metadata-lookup#55.*boom/);
});

test('a failed read does not hide the other refs', () => {
  const { readRef } = stubReader({ [`${R}#55`]: new Error('boom'), [`${R}#66`]: merged('Six') });
  const d = buildConfig(sinceSpec('#55 then #66'), loadTuning(), { readRef, warn: () => {} }).issues[0].description;
  assert.match(d, new RegExp(`^Since this plan was written: #66 merged \\(Six\\); #55 state unknown\\. ${SETTLED.replace(/[.*+?^${}()|[\]\\`]/g, '\\$&')}`));
});

// triagedAt comes from a model's return, so its zone is not trusted: no zone means UTC, and an unreadable
// value is ignored with a warning (the description stays unchanged).
for (const [name, triagedAt, closedAt, notes] of [
  ['a zoned UTC time', '2026-10-16T12:00:00Z', '2026-10-16T12:30:00Z', true],
  ['a zone-less time is read as UTC, so a close just after it counts', '2026-10-16T12:00:00', '2026-10-16T12:30:00Z', true],
  ['a zone-less time is read as UTC, so a close just before it does not', '2026-10-16T12:00:00', '2026-10-16T11:30:00Z', false],
  ['a numeric offset', '2026-10-16T05:00:00-07:00', '2026-10-16T12:30:00Z', true],
  ['a space-separated zone-less time is read as UTC, so a close just after it counts', '2026-10-16 12:00:00', '2026-10-16T12:30:00Z', true],
  ['a space-separated zone-less time is read as UTC, so a close just before it does not', '2026-10-16 12:00:00', '2026-10-16T11:30:00Z', false],
  ['a space-separated time with a Z', '2026-10-16 12:00:00Z', '2026-10-16T11:30:00Z', false],
  ['an offset with no colon', '2026-10-16T05:00:00-0700', '2026-10-16T12:30:00Z', true],
  ['an hour-only offset', '2026-10-16T17:00:00+05', '2026-10-16T12:30:00Z', true],
  ['an hour-only offset puts a close just before it out of the note', '2026-10-16T17:00:00+05', '2026-10-16T11:30:00Z', false],
]) {
  test(`triagedAt: ${name}`, () => {
    const { readRef } = stubReader({ [`${R}#55`]: merged('x', closedAt) });
    const d = buildConfig(sinceSpec('See #55.', { triagedAt }), loadTuning(), { readRef }).issues[0].description;
    assert.equal(d.startsWith('Since this plan was written: #55 merged (x)'), notes);
  });
}

for (const triagedAt of ['yesterday', 'October 16, 2026 12:00', '2026-10-16 noon', '16/10/2026 12:00']) {
  test(`an unreadable triagedAt (${triagedAt}) is ignored with a warning and no reads`, () => {
    const { readRef, calls } = stubReader({ [`${R}#55`]: merged('x') });
    const warnings = [];
    const d = buildConfig(sinceSpec('See #55.', { triagedAt }), loadTuning(), { readRef, warn: (m) => warnings.push(m) }).issues[0].description;
    assert.equal(d, 'See #55.');
    assert.deepEqual(calls, []);
    assert.match(warnings.join(), /triagedAt/);
  });
}

// V8 reads a zone-less time as host-local, and CI's host is UTC, which hides a missing UTC rule. So the
// zone-less cases run in child processes under zones either side of UTC, where reading them as local fails.
for (const tz of ['America/Los_Angeles', 'Pacific/Auckland']) {
  test(`a zone-less triagedAt is read as UTC even when the host zone is ${tz}`, () => {
    const child = `
      import { buildConfig } from ${JSON.stringify(new URL('./emit-config.mjs', import.meta.url).href)};
      import { load } from ${JSON.stringify(new URL('./lib/tuning.mjs', import.meta.url).href)};
      const out = {};
      for (const [k, triagedAt, closedAt] of JSON.parse(process.argv[1])) {
        const s = { name: 'n', repo: 'o/r', stateDir: '/s', projectRoot: '/p', promptTemplate: '/t', repos: { 'o/r': { baseBranch: 'main' } },
          issues: [{ number: 1, repo: 'o/r', digest: 'See #55.', triagedAt }] };
        const readRef = () => ({ state: 'closed', title: 'x', closed_at: closedAt, pull_request: { merged_at: closedAt } });
        out[k] = buildConfig(s, load(), { readRef }).issues[0].description.startsWith('Since this plan was written');
      }
      console.log(JSON.stringify(out));`;
    const cases = [
      ['T after', '2026-10-16T12:00:00', '2026-10-16T12:30:00Z'],
      ['T before', '2026-10-16T12:00:00', '2026-10-16T11:30:00Z'],
      ['space after', '2026-10-16 12:00:00', '2026-10-16T12:30:00Z'],
      ['space before', '2026-10-16 12:00:00', '2026-10-16T11:30:00Z'],
    ];
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', child, JSON.stringify(cases)], { encoding: 'utf8', env: { ...process.env, TZ: tz } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { 'T after': true, 'T before': false, 'space after': true, 'space before': false });
  });
}

test('a date-only triagedAt is read as midnight UTC and warns that it is not a time', () => {
  const { readRef } = stubReader({ [`${R}#55`]: merged('x', '2026-10-16T12:30:00Z') });
  const warnings = [];
  const d = buildConfig(sinceSpec('See #55.', { triagedAt: '2026-10-16' }), loadTuning(), { readRef, warn: (m) => warnings.push(m) }).issues[0].description;
  assert.ok(d.startsWith('Since this plan was written: #55 merged (x)'));
  assert.match(warnings.join(), /triagedAt.*2026-10-16.*date only/);
});

test('one read serves every issue in the wave that names the same ref, and a failed read is not retried', () => {
  const { readRef, calls } = stubReader({ [`${R}#55`]: merged('Fifty-five'), [`${R}#66`]: new Error('boom') });
  const s = spec({ issues: [1, 2, 3].map((n) => ({ number: n, repo: R, digest: 'See #55 and #66.', triagedAt: TRIAGED })) });
  const c = buildConfig(s, loadTuning(), { readRef, warn: () => {} });
  assert.deepEqual(calls, [`${R}#55`, `${R}#66`]);
  for (const i of c.issues) assert.match(i.description, /#55 merged \(Fifty-five\).*#66 state unknown/);
});

test('the block names the repo\'s own base branch', () => {
  const { readRef } = stubReader({ [`${R}#66`]: merged('Six') });
  const s = sinceSpec('#66');
  s.repos[R].baseBranch = 'develop';
  assert.match(buildConfig(s, loadTuning(), { readRef }).issues[0].description, /on `origin\/develop` before editing/);
});

test('ghReadRef reads the issues endpoint with a timeout and parses the row', () => {
  const seen = [];
  const run = (args, opts) => { seen.push({ args, opts }); return JSON.stringify({ state: 'open', title: 'T' }); };
  assert.deepEqual(ghReadRef('o/r', 12, run), { state: 'open', title: 'T' });
  assert.deepEqual(seen[0].args, ['api', 'repos/o/r/issues/12']);
  assert.ok(seen[0].opts.timeout > 0);
});

test('realRunGh forwards its options, so the timeout cuts off a stalled gh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\nexec sleep 10\n');
  chmodSync(join(dir, 'gh'), 0o755);
  const started = Date.now();
  assert.throws(() => realRunGh(['api', 'x'], { timeout: 200, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }), (err) => err.code === 'ETIMEDOUT');
  assert.ok(Date.now() - started < 5000);
});
