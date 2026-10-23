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
import { docLine } from './lib/doc-pins.mjs';
import { coHome, coDistPath } from './lib/co-home.mjs';
import { ghStubBin, graphqlFailure, restFailure } from './lib/gh-fixture.mjs';
import { composeCiLine, cliArgs, commandsFor, exitCodeFor, runCiProfile, setupProblem, spawnFailure } from './run-ci-profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILES = JSON.parse(readFileSync(join(HERE, '..', 'references', 'repo-ci-profiles.json'), 'utf8')).profiles;
const CO_HOME = coHome();
// GraphQL answers for scripts/ci on the default branch, as recorded (see lib/ci-profile.test.mjs).
const onMain = (file) => ({ data: { repository: { defaultBranchRef: { name: 'main', target: { file } } } } });
const DECLARED = { stdout: JSON.stringify(onMain({ mode: 0o100755, type: 'blob' })) };
const UNDECLARED = graphqlFailure({ ...onMain(null), errors: [{ type: 'NOT_FOUND', path: ['repository', 'defaultBranchRef', 'target', 'file'], message: "Could not resolve file for path 'scripts/ci'." }] });
const hasCli = existsSync(coDistPath(process.env, 'cli-lease.js'));

const scratch = () => mkdtempSync(join(tmpdir(), 'run-ci-profile-'));
const isolatedEnv = (leaseDir) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CO_LEASE_')));
  return { ...env, CO_HOME, CO_LEASE_DIR: leaseDir, CO_LEASE_SLOTS: '1', CO_PRESSURE_OVERRIDE: 'critical-as-warning' };
};
const run = (commands, worktree, leaseDir, maxWait) =>
  runCiProfile({ profile: { repo: 'o/r', commands }, worktree, env: isolatedEnv(leaseDir), maxWait, stdio: 'pipe' });

test('composeCiLine: each command in its own subshell, joined with &&', () => {
  assert.equal(composeCiLine(['a', 'b']), '(\na\n) && (\nb\n)');
});

test('commandsFor: the resolved profile\'s commands, refusing one with none in the text failure.mjs matches', () => {
  assert.deepEqual(commandsFor({ repo: 'o/r', commands: ['x'] }), ['x']);
  assert.deepEqual(commandsFor({ repo: 'o/r', commands: ['scripts/ci'], source: 'repo' }), ['scripts/ci']);
  assert.throws(() => commandsFor({ repo: 'o/none', commands: [], source: 'none' }), /^Error: no CI profile for o\/none$/);
  assert.throws(() => commandsFor({ repo: 'o/r' }), /^Error: no CI profile for o\/r$/);
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

test('setupProblem: names a missing worktree or a missing lease CLI; null when both present', () => {
  const dir = scratch();
  try {
    const ok = { worktree: dir, coHome: fakeCoHome(dir, { withCli: true }) };
    assert.equal(setupProblem(ok), null);
    assert.match(setupProblem({ ...ok, worktree: join(dir, 'gone') }), /worktree.*gone.*does not exist/);
    assert.match(setupProblem({ ...ok, coHome: fakeCoHome(dir, { withCli: false }) }), /cli-lease\.js.*build or point CO_HOME at a claude-orchestrator checkout/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cliArgs and setupProblem join an explicit coHome as-is: empty is relative, undefined cannot be joined', () => {
  assert.equal(cliArgs({ repo: 'o/r', line: 'true', coHome: '', maxWait: 1 })[0], join('dist', 'src', 'cli-lease.js'));
  assert.throws(() => cliArgs({ repo: 'o/r', line: 'true', coHome: undefined, maxWait: 1 }), TypeError);
  const dir = scratch();
  try {
    assert.match(setupProblem({ worktree: dir, coHome: '' }), /^dist.src.cli-lease\.js not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the script exits 64 with a named stderr line on each setup failure, and on a usage error', () => {
  const dir = scratch();
  try {
    const home = fakeCoHome(dir, { withCli: true });
    const missingWt = cli(['--repo', 'jakebromberg/code-audit-pipeline', '--worktree', join(dir, 'gone')], { CO_HOME: home });
    assert.equal(missingWt.status, 64);
    assert.match(missingWt.stderr, /worktree.*gone/);
    const noCli = cli(['--repo', 'jakebromberg/code-audit-pipeline', '--worktree', dir], { CO_HOME: fakeCoHome(dir, { withCli: false }) });
    assert.equal(noCli.status, 64);
    assert.match(noCli.stderr, /cli-lease\.js.*CO_HOME/);
    const noProfile = cli(['--repo', 'o/none', '--worktree', dir], { CO_HOME: home, PATH: `${ghStubBin(dir, UNDECLARED)}:${process.env.PATH}` });
    assert.equal(noProfile.status, 64);
    assert.match(noProfile.stderr, /^run-ci-profile: no CI profile for o\/none$/m);
    assert.equal(cli([]).status, 64);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A repo with no registry entry runs its own scripts/ci; the stub lease CLI records the line it was given.
test('a repo with no registry entry and a scripts/ci on its base branch runs scripts/ci under the lease', () => {
  const dir = scratch();
  try {
    const home = fakeCoHome(dir, { withCli: true });
    const argvFile = join(dir, 'lease-argv.json');
    writeFileSync(join(home, 'dist', 'src', 'cli-lease.js'), `require('node:fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`);
    writeFileSync(join(home, 'package.json'), '{"type":"commonjs"}');
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'ci'), '#!/bin/sh\n', { mode: 0o755 });
    const r = cli(['--repo', 'o/declared', '--worktree', dir], { CO_HOME: home, PATH: `${ghStubBin(dir, DECLARED)}:${process.env.PATH}` });
    assert.equal(r.status, 0, r.stderr);
    const argv = JSON.parse(readFileSync(argvFile, 'utf8'));
    assert.equal(argv[argv.indexOf('--shell') + 1], composeCiLine(['scripts/ci']));
    assert.equal(argv[argv.indexOf('--label') + 1], 'run-ci-profile o/declared');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a scripts/ci merged after the worktree was cut is not run there: exit 64 with no CI profile, unverified as step 4 left it', () => {
  const dir = scratch();
  try {
    const r = cli(['--repo', 'o/declared', '--worktree', dir], { CO_HOME: fakeCoHome(dir, { withCli: true }), PATH: `${ghStubBin(dir, DECLARED)}:${process.env.PATH}` });
    assert.equal(r.status, 64);
    assert.match(r.stderr, /^run-ci-profile: no CI profile for o\/declared$/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an issue ref passed as --repo is a usage error, not an unverified repo', () => {
  const dir = scratch();
  try {
    const r = cli(['--repo', 'o/r#123', '--worktree', dir], { CO_HOME: fakeCoHome(dir, { withCli: true }) });
    assert.equal(r.status, 64);
    assert.match(r.stderr, /usage: run-ci-profile\.mjs --repo <owner\/repo>/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a scripts/ci lookup that fails exits 64 naming it, never a test failure', () => {
  const dir = scratch();
  try {
    const bin = ghStubBin(dir, restFailure(500, 'Server Error', ['api', 'graphql']));
    const r = cli(['--repo', 'o/flaky', '--worktree', dir], { CO_HOME: fakeCoHome(dir, { withCli: true }), PATH: `${bin}:${process.env.PATH}` });
    assert.equal(r.status, 64);
    assert.match(r.stderr, /^run-ci-profile: o\/flaky: could not look up scripts\/ci: Server Error \(HTTP 500\)$/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a flag followed by another flag exits 64 with a usage message naming the flag', () => {
  const r = cli(['--repo', '--worktree', 'x']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /--repo requires a value/);
});

test('a lease CLI killed by a signal exits 128 + the signal number and names the signal', () => {
  const dir = scratch();
  try {
    const home = fakeCoHome(dir, { withCli: true });
    writeFileSync(join(home, 'dist', 'src', 'cli-lease.js'), "process.kill(process.pid, 'SIGTERM');\n");
    const r = cli(['--repo', 'jakebromberg/code-audit-pipeline', '--worktree', dir], { CO_HOME: home });
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
  const holder = spawn(process.execPath, [coDistPath(process.env, 'cli-lease.js'), '--shell', 'sleep 30'], { env: isolatedEnv(dir), stdio: 'ignore' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(run(['true'], dir, dir, 1).status, 75);
  } finally {
    // Wait for the killed holder to exit: it may still be removing its lease file, and deleting the
    // directory under it fails with ENOTEMPTY (#202).
    const exited = holder.exitCode !== null || holder.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => holder.once('exit', resolve));
    holder.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('SKILL.md step 6.2 re-runs local CI through run-ci-profile.mjs', () => {
  const step = docLine('2. **If the rebase moved the base**');
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
    assert.match(docLine(marker), /run-ci-profile\.mjs` exit 75 in step 6\.2 is bounded[^.]*30-minute cap/, marker);
  }
});
