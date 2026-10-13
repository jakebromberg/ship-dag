// Tests for the step-6.2 CI runner: the pure composition, the CLI argv it builds,
// and (through the real claude-orchestrator lease CLI, isolated to a temp lease
// dir) the exit-code and subshell semantics.
// Run: node --test 'scripts/**/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeCiLine, cliArgs, commandsFor, exitCodeFor, runCiProfile, setupProblem, spawnFailure } from './run-ci-profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILES = JSON.parse(readFileSync(join(HERE, '..', 'references', 'repo-ci-profiles.json'), 'utf8')).profiles;
const CO_HOME = process.env.CO_HOME || '/Users/jake/Developer/claude-orchestrator';
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

test('exitCodeFor: the child status passes through, a signal is 128 + its number, a spawn error is 64', () => {
  assert.equal(exitCodeFor({ status: 0 }), 0);
  assert.equal(exitCodeFor({ status: 7 }), 7);
  assert.equal(exitCodeFor({ status: null, signal: 'SIGKILL' }), 128 + osConstants.signals.SIGKILL);
  assert.equal(exitCodeFor({ status: null, signal: 'SIGTERM' }), 128 + osConstants.signals.SIGTERM);
  assert.equal(exitCodeFor({ status: null, error: new Error('x') }), 64);
});

// Setup failures exit 64 with one stderr line naming the actual problem, never 1 (a failing suite).
const fakeCoHome = (dir, { withCli }) => {
  const home = join(dir, withCli ? 'co-home' : 'co-home-unbuilt');
  if (withCli) { mkdirSync(join(home, 'dist', 'src'), { recursive: true }); writeFileSync(join(home, 'dist', 'src', 'cli-lease.js'), ''); }
  return home;
};
const SCRIPT = join(HERE, 'run-ci-profile.mjs');
const cli = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('setupProblem: names a missing worktree, a missing lease CLI, or a repo with no profile; null when all present', () => {
  const dir = scratch();
  try {
    const profiles = join(dir, 'profiles.json');
    writeFileSync(profiles, JSON.stringify({ profiles: { 'o/r': { commands: ['true'] } } }));
    const ok = { repo: 'o/r', worktree: dir, profilesPath: profiles, coHome: fakeCoHome(dir, { withCli: true }) };
    assert.equal(setupProblem(ok), null);
    assert.match(setupProblem({ ...ok, worktree: join(dir, 'gone') }), /worktree.*gone.*does not exist/);
    assert.match(setupProblem({ ...ok, coHome: fakeCoHome(dir, { withCli: false }) }), /cli-lease\.js.*build or point CO_HOME at a claude-orchestrator checkout/);
    assert.match(setupProblem({ ...ok, repo: 'o/none' }), /no CI profile for o\/none/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the script exits 64 with a named stderr line on each setup failure, and on a usage error', () => {
  const dir = scratch();
  try {
    const coHome = fakeCoHome(dir, { withCli: true });
    const missingWt = cli(['--repo', 'jakebromberg/code-audit-pipeline', '--worktree', join(dir, 'gone')], { CO_HOME: coHome });
    assert.equal(missingWt.status, 64);
    assert.match(missingWt.stderr, /worktree.*gone/);
    const noCli = cli(['--repo', 'jakebromberg/code-audit-pipeline', '--worktree', dir], { CO_HOME: fakeCoHome(dir, { withCli: false }) });
    assert.equal(noCli.status, 64);
    assert.match(noCli.stderr, /cli-lease\.js.*CO_HOME/);
    const noProfile = cli(['--repo', 'o/none', '--worktree', dir], { CO_HOME: coHome });
    assert.equal(noProfile.status, 64);
    assert.match(noProfile.stderr, /no CI profile for o\/none/);
    assert.equal(cli([]).status, 64);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a lease CLI killed by a signal exits 128 + the signal number and names the signal', () => {
  const dir = scratch();
  try {
    const coHome = fakeCoHome(dir, { withCli: true });
    writeFileSync(join(coHome, 'dist', 'src', 'cli-lease.js'), "process.kill(process.pid, 'SIGTERM');\n");
    const r = cli(['--repo', 'jakebromberg/code-audit-pipeline', '--worktree', dir], { CO_HOME: coHome });
    assert.equal(r.status, 128 + osConstants.signals.SIGTERM);
    assert.match(r.stderr, /killed by SIGTERM/);
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
  // The 15-minute bound routes through the preflight with the summed wait, so critical pressure reaches point F.
  assert.match(step, /15 minutes[^.]*resource-preflight\.mjs" check[^.]*--waited-minutes/);
  // The exit-code contract: 75 rerun, 64 setup error (never a test failure, never a rerun), anything else the suite's own result.
  assert.match(step, /75[^.]*rerun/);
  assert.match(step, /64[^.]*setup error[^.]*never a test failure[^.]*never a rerun/);
  assert.match(step, /anything else[^.]*suite/);
  // The preflight returns proceed at every level below critical, so busy slots alone need their own cap.
  assert.match(step, /30 minutes[^.]*whatever the pressure[^.]*point F/);
  // Step 6's no-loop rule and the Guardrails name the same cap, not the preflight alone.
  for (const marker of ['**Never loop-retry a failing CI or merge.**', '- **No auto-retry loops**']) {
    const line = skill.split('\n').find((l) => l.startsWith(marker));
    assert.match(line, /run-ci-profile\.mjs` exit 75 in step 6\.2 is bounded[^.]*30-minute cap/, marker);
  }
});
