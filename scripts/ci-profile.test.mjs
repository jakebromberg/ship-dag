// Tests for SKILL.md step 4's per-repo CI lookup CLI. The resolution itself is tested in lib/ci-profile.test.mjs;
// these pin the CLI's output shape and exit codes, with a stub `gh` first on PATH so nothing reaches GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reposMap } from './ci-profile.mjs';
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
  assert.ok(!commands.some((c) => /^npm run lint( |$)/.test(c) || /eslint \./.test(c)));
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
