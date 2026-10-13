// Tests for the step-6.2 CI runner: the pure composition, the CLI argv it builds,
// and (through the real claude-orchestrator lease CLI, isolated to a temp lease
// dir) the exit-code and subshell semantics.
// Run: node --test 'scripts/**/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeCiLine, cliArgs, commandsFor, runCiProfile, spawnFailure } from './run-ci-profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILES = JSON.parse(readFileSync(join(HERE, '..', 'references', 'repo-ci-profiles.json'), 'utf8')).profiles;
const CO_HOME = process.env.CO_HOME || '/Users/me/Developer/claude-orchestrator';
const hasCli = existsSync(join(CO_HOME, 'dist', 'src', 'cli-lease.js'));

const scratch = () => mkdtempSync(join(tmpdir(), 'run-ci-profile-'));
const isolatedEnv = (leaseDir) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CO_LEASE_')));
  return { ...env, CO_HOME, CO_LEASE_DIR: leaseDir, CO_LEASE_SLOTS: '1', CO_PRESSURE_OVERRIDE: 'critical-as-warning' };
};
const run = (commands, worktree, leaseDir, maxWait) => {
  const profiles = join(leaseDir, 'profiles.json');
  writeFileSync(profiles, JSON.stringify({ profiles: { 'o/r': { commands } } }));
  return runCiProfile({ repo: 'o/r', worktree, profilesPath: profiles, env: isolatedEnv(leaseDir), maxWait, stdio: 'pipe' });
};

test('composeCiLine: each command in its own subshell, joined with &&', () => {
  assert.equal(composeCiLine(['a', 'b']), '(\na\n) && (\nb\n)');
});

test('commandsFor: reads the repo profile, refusing an unknown repo or one with no commands', () => {
  assert.deepEqual(commandsFor('o/r', { 'o/r': { commands: ['x'] } }), ['x']);
  assert.throws(() => commandsFor('o/none', {}), /no CI profile for o\/none/);
  assert.throws(() => commandsFor('o/r', { 'o/r': { commands: [] } }), /no CI profile for o\/r/);
});

test('cliArgs: lease CLI with the wait cap, a credential-free label and the line as one --shell argument', () => {
  const args = cliArgs({ repo: 'o/r', line: "echo 'a \"b\" $(c)'", coHome: '/co', maxWait: 100 });
  assert.deepEqual(args, ['/co/dist/src/cli-lease.js', '--max-wait', '100', '--label', 'run-ci-profile o/r', '--shell', "echo 'a \"b\" $(c)'"]);
});

test('every shipped profile composes to a line /bin/sh parses, one subshell per command', () => {
  for (const [repo, { commands = [] }] of Object.entries(PROFILES)) {
    const line = composeCiLine(commands);
    assert.equal(line.split('\n) && (\n').length, commands.length || 1, repo);
    const r = spawnSync('/bin/sh', ['-n', '-c', line], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${repo}: ${r.stderr}`);
  }
});

test('spawnFailure: names a spawn error or a signal, and is silent on a normal exit', () => {
  assert.equal(spawnFailure({ status: 3 }), null);
  assert.match(spawnFailure({ status: null, error: Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }) }), /could not start.*ENOENT/);
  assert.match(spawnFailure({ status: null, signal: 'SIGKILL' }), /killed by SIGKILL/);
});

test('a missing worktree surfaces as a spawn error', () => {
  const dir = scratch();
  try {
    const r = run(['true'], join(dir, 'no-such-worktree'), dir);
    assert.equal(r.status, null);
    assert.match(spawnFailure(r), /could not start.*ENOENT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const real = { skip: !hasCli && `no claude-orchestrator build at ${CO_HOME}` };

test('exit code passes through', real, () => {
  const dir = scratch();
  try {
    assert.equal(run(['true'], dir, dir).status, 0);
    assert.equal(run(['exit 7'], dir, dir).status, 7);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failure before an || { …; } tail still fails and short-circuits (daisysguide/ios shape)', real, () => {
  const dir = scratch();
  try {
    // Joined with a plain `&&`, `false && missing || { exit 0; } && touch …` would run the tail and exit 0.
    const r = run(['false', 'xcodebuild_missing_cmd > /dev/null 2>&1 || { echo tail; exit 0; }', 'touch ran-third'], dir, dir);
    assert.equal(r.status, 1);
    assert.doesNotMatch(String(r.stdout), /tail/);
    assert.equal(existsSync(join(dir, 'ran-third')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a cd <subdir> never leaks into the next command (triangle-shows shape)', real, () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, 'backend'));
    const r = run(['cd backend || exit 1; pwd > ../first', 'pwd > second'], dir, dir);
    assert.equal(r.status, 0);
    assert.equal(readFileSync(join(dir, 'first'), 'utf8').trim(), join(realpathSync(dir), 'backend'));
    assert.equal(readFileSync(join(dir, 'second'), 'utf8').trim(), realpathSync(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the code-audit-pipeline status= assignment passes under /bin/sh', real, () => {
  const dir = scratch();
  try {
    const cmd = PROFILES['jakebromberg/code-audit-pipeline'].commands.find((c) => c.startsWith('status='));
    assert.ok(cmd);
    spawnSync('git', ['init', '-q'], { cwd: dir });
    assert.equal(run([cmd], dir, dir).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('exit 75 when no slot frees within the wait cap', real, async () => {
  const dir = scratch();
  const holder = spawn(process.execPath, [join(CO_HOME, 'dist', 'src', 'cli-lease.js'), '--shell', 'sleep 30'], { env: isolatedEnv(dir), stdio: 'ignore' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(run(['true'], dir, dir, 1).status, 75);
  } finally {
    holder.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SKILL.md step 6.2 re-runs local CI through run-ci-profile.mjs', () => {
  const skill = readFileSync(join(HERE, '..', 'SKILL.md'), 'utf8');
  const step = skill.split('\n').find((l) => l.startsWith('2. **If the rebase moved the base**'));
  assert.match(step, /scripts\/run-ci-profile\.mjs/);
});
