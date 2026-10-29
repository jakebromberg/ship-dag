// Tests for SKILL.md step 4's per-repo CI lookup CLI. The resolution itself is tested in lib/ci-profile.test.mjs;
// these pin the CLI's output shape and exit codes, with a stub `gh` first on PATH so nothing reaches GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reposMap } from './ci-profile.mjs';
import { loadProfiles, localLintProblem, localLintRule } from './lib/ci-profile.mjs';
import { ghStubBin, graphqlFailure, restFailure } from './lib/gh-fixture.mjs';

const SCRIPT = fileURLToPath(new URL('./ci-profile.mjs', import.meta.url));
const REGISTERED = 'jakebromberg/code-audit-pipeline';
// GraphQL answers as recorded (see lib/ci-profile.test.mjs): an executable scripts/ci on the default branch, and a
// missing one, which gh exits 1 on.
const branch = (file) => ({ data: { repository: { defaultBranchRef: { name: 'main', target: { file } } } } });
const MISSING_STDOUT = JSON.stringify(branch(null));
const FILE = JSON.stringify(branch({ mode: 0o100755, type: 'blob' }));
const MISSING = graphqlFailure({ ...branch(null), errors: [{ type: 'NOT_FOUND', path: ['repository', 'defaultBranchRef', 'target', 'file'], message: "Could not resolve file for path 'scripts/ci'." }] });

/** Runs the CLI with a stub gh answering every call with `answer` (stdout, or a failure's stdout/stderr/status). */
function cli(args, answer = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-profile-'));
  try {
    const bin = ghStubBin(dir, typeof answer === 'string' ? { stdout: answer } : answer);
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("prints a repos map ready for the spec's repos, one entry per repo argument", () => {
  const r = cli([REGISTERED, 'o/declared'], FILE);
  assert.equal(r.status, 0, r.stderr);
  const repos = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(repos), [REGISTERED, 'o/declared']);
  assert.equal(repos[REGISTERED].source, 'registry');
  assert.ok(repos[REGISTERED].commands.length > 0);
  assert.deepEqual(repos['o/declared'], { baseBranch: 'main', commands: ['scripts/ci'], source: 'repo' });
});

test('a repo with neither an entry nor scripts/ci prints no commands and exits 0 (emit-config warns)', () => {
  const r = cli(['o/bare'], MISSING);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { 'o/bare': { baseBranch: 'main', commands: [], source: 'none' } });
});

test('a lookup failure exits 1 naming the repo, and prints nothing on stdout', () => {
  const r = cli(['o/flaky'], restFailure(500, 'Server Error', ['api', 'graphql']));
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^ci-profile: o\/flaky: could not look up scripts\/ci: Server Error \(HTTP 500\)$/m);
});

for (const [name, args] of [['no repo', []], ['a repo that is not owner/repo', ['just-a-name']], ['an issue ref', ['o/r#12']]]) {
  test(`usage: ${name} exits 64`, () => {
    const r = cli(args);
    assert.equal(r.status, 64);
    assert.match(r.stderr, /usage: ci-profile\.mjs <owner\/repo>/);
  });
}

test("prints a registry entry's host, so a spec's repos map carries it to emit-config --by-host", async () => {
  const repos = await reposMap([REGISTERED], { profiles: { [REGISTERED]: { commands: ['npm test'], host: 'box' } } });
  assert.deepEqual(repos[REGISTERED], { baseBranch: 'main', commands: ['npm test'], source: 'registry', host: 'box' });
});

test('the Backend-Service profile runs typecheck:tests and the dummy-env audit-coverage check right after typecheck, as test.yml does', async () => {
  const commands = await backendServiceCommands();
  const at = commands.indexOf('npm run typecheck');
  assert.notEqual(at, -1);
  assert.deepEqual(commands.slice(at + 1, at + 3), [
    'npm run typecheck:tests',
    'NODE_ENV=test DB_HOST=localhost DB_NAME=dummy DB_USERNAME=dummy DB_PASSWORD=dummy npm run check:audit-coverage:ci',
  ]);
});

test('the Backend-Service profile lints the changed files, never the whole repo, and does not skip a missing script', async () => {
  const commands = await backendServiceCommands();
  assert.ok(commands.includes('npm run lint:changed'));
  // Every whole-repo alias: bare lint, lint:fast and lint:fix (all `eslint .` with a 12 GB heap), or a literal `eslint .`.
  const wholeRepoLint = /^npm run lint(:fast|:fix)?( |$)|eslint \./;
  assert.deepEqual(commands.filter((c) => wholeRepoLint.test(c)), []);
  assert.ok(!commands.some((c) => c.includes('--if-present')));
});

/** The Backend-Service commands from the real registry, with a stub gh so a lost entry cannot reach GitHub. */
async function backendServiceCommands() {
  const dir = mkdtempSync(join(tmpdir(), 'ci-profile-'));
  const saved = process.env.PATH;
  try {
    process.env.PATH = `${ghStubBin(dir, { stdout: MISSING_STDOUT })}:${saved}`;
    const { 'WXYC/Backend-Service': { commands } } = await reposMap(['WXYC/Backend-Service']);
    return commands;
  } finally { process.env.PATH = saved; rmSync(dir, { recursive: true, force: true }); }
}

test("prints a registry entry's localLint, so a spec's repos map carries it to emit-config", async () => {
  const localLint = { command: 'npm run lint:changed', forbid: ['npm run lint'] };
  const repos = await reposMap([REGISTERED], { profiles: { [REGISTERED]: { commands: ['npm test'], localLint } } });
  assert.deepEqual(repos[REGISTERED].localLint, localLint);
});

test('the Backend-Service profile declares npm run lint:changed as its local lint, equal to the lint in its commands, and forbids every whole-repo lint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-profile-'));
  const saved = process.env.PATH;
  try {
    process.env.PATH = `${ghStubBin(dir, { stdout: MISSING_STDOUT })}:${saved}`;
    const { 'WXYC/Backend-Service': { commands, localLint } } = await reposMap(['WXYC/Backend-Service']);
    assert.equal(localLint.command, 'npm run lint:changed');
    assert.ok(commands.includes(localLint.command));
    assert.deepEqual(localLint.forbid, ['npm run lint', 'npm run lint:fast', 'npm run lint:fix', 'eslint .']);
    assert.deepEqual(localLint.forbid.filter((f) => commands.includes(f)), []);
  } finally { process.env.PATH = saved; rmSync(dir, { recursive: true, force: true }); }
});

test('only Backend-Service declares a local lint', async () => {
  const declared = Object.entries(loadProfiles()).filter(([, p]) => p.localLint).map(([repo]) => repo);
  assert.deepEqual(declared, ['WXYC/Backend-Service']);
});

// One renderer for every implement path: emit-config appends it to the description, and the fallbacks append it to the digest.
test('localLintRule names the command, every forbidden one and the registry note, and claims nothing else', () => {
  assert.equal(localLintRule({ command: 'make lint', forbid: ['make all'] }), 'Local lint (binding): for the lint step of local CI, run `make lint`. Never run `make all` in this session.');
  assert.equal(localLintRule({ command: 'make lint', forbid: ['a', 'b', 'c'], note: 'It is fast.' }), 'Local lint (binding): for the lint step of local CI, run `make lint`. Never run `a`, `b` or `c` in this session. It is fast.');
  assert.equal(localLintRule({ command: ' make lint ' }), 'Local lint (binding): for the lint step of local CI, run `make lint`.');
});

for (const [name, localLint] of [['absent', undefined], ['null', null]]) {
  test(`localLintRule is empty for a localLint ${name}`, () => assert.equal(localLintRule(localLint), ''));
}

for (const [name, localLint, problem] of [
  ['absent', undefined, ''], ['null', null, ''], ['well formed', { command: 'x', forbid: ['y'], note: 'n' }, ''],
  ['a string', 'x', /object/], ['an array', [], /object/],
  ['without a command', { forbid: ['a'] }, /command/], ['with a typo for command', { commnd: 'x' }, /command/], ['with a blank command', { command: ' ' }, /command/], ['with a numeric command', { command: 5 }, /command/],
  ['with a string forbid', { command: 'x', forbid: 'eslint .' }, /forbid/], ['with a blank forbid entry', { command: 'x', forbid: [' '] }, /forbid/],
  ['with a non-string note', { command: 'x', note: 3 }, /note/],
]) {
  test(`localLintProblem for a localLint ${name}`, () => {
    const got = localLintProblem(localLint);
    if (problem === '') assert.equal(got, ''); else assert.match(got, problem);
  });
}

test('the registry comment and ci-profile.mjs usage name the localLint shape and the --local-lint-rule form', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  assert.match(readFileSync(join(root, 'references/repo-ci-profiles.json'), 'utf8'), /\{command, forbid, note\?\}/);
  assert.match(readFileSync(join(root, 'scripts/emit-config.mjs'), 'utf8'), /localLint: \{command, forbid, note\?\}/);
  const r = spawnSync(process.execPath, [join(root, 'scripts/ci-profile.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /--local-lint-rule/);
});

// A malformed registry entry must fail the CLI loudly (exit 2, repo named, nothing on stdout), not print a bad rule or crash.
for (const [name, localLint] of [['a string forbid', { command: 'x', forbid: 'eslint .' }], ['a non-string note', { command: 'x', note: 3 }], ['a missing command', { forbid: ['a'] }]]) {
  test(`--local-lint-rule exits 2 naming the repo for ${name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-profile-'));
    try {
      const file = join(dir, 'profiles.json');
      writeFileSync(file, JSON.stringify({ profiles: { 'WXYC/bad-repo': { commands: ['x'], localLint } } }));
      const r = spawnSync(process.execPath, [fileURLToPath(new URL('./ci-profile.mjs', import.meta.url)), '--local-lint-rule', 'WXYC/bad-repo'], { encoding: 'utf8', env: { ...process.env, SHIP_DAG_CI_PROFILES: file } });
      assert.equal(r.status, 2);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /WXYC\/bad-repo/);
      assert.match(r.stderr, /localLint/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("Backend-Service's note says what lint:changed does: changed files, and a full lint when lint config, a tsconfig, a package file or a .d.ts changes", () => {
  const { note } = loadProfiles()['WXYC/Backend-Service'].localLint;
  for (const re of [/changed files/, /tsconfig/, /package/, /\.d\.ts/, /eslint config/i]) assert.match(note, re);
});

test('--local-lint-rule prints the rule for a registered repo and nothing for an undeclared one', () => {
  const run = (repo) => spawnSync(process.execPath, [fileURLToPath(new URL('./ci-profile.mjs', import.meta.url)), '--local-lint-rule', repo], { encoding: 'utf8' });
  const bs = run('WXYC/Backend-Service');
  assert.equal(bs.status, 0);
  assert.equal(bs.stdout, `${localLintRule(loadProfiles()['WXYC/Backend-Service'].localLint)}\n`);
  const other = run('WXYC/dj-site');
  assert.equal(other.status, 0);
  assert.equal(other.stdout, '');
});
