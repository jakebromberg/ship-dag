// Tests for the host-run flow. The runner is injected, so no test opens a connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli as entry, hostRun, main, realRunner } from './host-run.mjs';
import { readLatestUtilization } from './rate-limit-preflight.mjs';
import { LOG_CHUNK, parsePoll, pollScript, preflightCommand, rsyncArgs, worktreeScript } from './lib/host-run.mjs';
import { scopedEngineFixture } from './lib/engine-fixture.mjs';
import { testHost } from './lib/host-fixture.mjs';

const box = testHost('/h', {}, 'boxssh');
const stateDir = '/h/.local/state/ship-dag/engine/run1';
// The pre-launch check's reply for a host state dir with no report yet.
const FRESH = { status: 0, stdout: 'reports= 0\n', stderr: '' };
const LAUNCHED = { status: 0, stdout: 'Detached orchestrator (PID 77)\nLog: /l\n', stderr: '' };
const poll = (alive, reports, log = '') => ({ status: 0, stdout: Buffer.concat([Buffer.from(`alive=${alive}\nreports=${reports}\n---\n`), Buffer.from(log)]), stderr: '' });
const failedToRun = (code) => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: Object.assign(new Error(`spawnSync ssh ${code}`), { code }) });
const MINUTE = 60_000;

/** Run `hostRun` with `ssh` answering from `replies` in order (rsync with `rsyncReply`) on a clock only `sleep` moves; returns what it did. */
async function go(replies, { rsyncReply = { status: 0, stderr: '' }, ...opts } = {}) {
  const calls = { ssh: [], rsync: [], emitted: '', logged: [], slept: 0 };
  let clock = 0;
  const run = {
    ssh: (alias, command) => (calls.ssh.push([alias, command]), replies.shift()),
    rsync: (args) => (calls.rsync.push(args), rsyncReply),
  };
  const code = await hostRun({
    name: 'box', host: box, stateDir, localState: '/l', run, emit: (t) => (calls.emitted += t), log: (m) => calls.logged.push(m),
    sleep: async (ms) => { calls.slept += 1; clock += ms; }, now: () => clock, reattach: 'RE', collect: 'COLLECT', ...opts,
  });
  return { code, ...calls };
}

test('a run launches detached, recording the pid on the host, polls until the engine exits with a report, then collects and exits 0', async () => {
  const r = await go([FRESH, LAUNCHED, poll(1, 0, 'one\n'), poll(1, 0, 'two\npart'), poll(0, 1, 'partial\n')]);
  assert.equal(r.code, 0);
  assert.match(r.ssh[0][1], /^echo reports=\$\(ls '\/h\/\.local\/state\/ship-dag\/engine\/run1\/state\/reports'\/\*\.json/);
  assert.match(r.ssh[1][1], /--parallel 1 --detach; } 2>&1\); .*> '\/h\/\.local\/state\/ship-dag\/engine\/run1\/host-run\.pid'/);
  assert.match(r.ssh[2][1], /host-run\.pid/);
  assert.match(r.ssh[3][1], /tail -c \+5 /);
  assert.match(r.ssh[4][1], /tail -c \+9 /);
  assert.equal(r.emitted, `${LAUNCHED.stdout}one\ntwo\npartial\n`);
  assert.equal(r.slept, 2);
  assert.equal(r.rsync.length, 1);
  assert.deepEqual(r.rsync[0].slice(-2), [`boxssh:${stateDir}/state/`, '/l/state/']);
  assert.deepEqual(r.logged, []);
});

test('an engine that exits with no report exits 1 naming the remote log, and still collects', async () => {
  const r = await go([FRESH, LAUNCHED, poll(0, 0)]);
  assert.equal(r.code, 1);
  assert.match(r.logged.join('\n'), /no report; see boxssh:\/h\/\.local\/state\/ship-dag\/engine\/run1\/state\/logs\/orchestrator\.log/);
  assert.equal(r.rsync.length, 1);
});

// A throw after the launch (a full local disk under emit, a failing rsync call) leaves an engine that may be running: exit 255 with the --collect-only command, never a relaunch.
const boom = () => { throw new Error('ENOSPC: no space left on device'); };
for (const [name, replies, opts] of [
  ['the launch output is emitted', [FRESH, LAUNCHED], { emit: boom }],
  ['a poll\'s log is emitted', [FRESH, LAUNCHED, poll(1, 0, 'x\n')], { emit: (() => { let n = 0; return () => { if (++n > 1) boom(); }; })() }],
  ['--collect-only emits', [poll(0, 1, 'x\n')], { collectOnly: true, emit: boom }],
  ['rsync throws', [FRESH, LAUNCHED, poll(0, 1)], { rsyncReply: { get status() { return boom(); } } }],
]) {
  test(`a throw after the launch (${name}) exits 255 with the --collect-only command and starts nothing more`, async () => {
    const r = await go(replies, opts);
    assert.equal(r.code, 255, String(r.stack ?? ''));
    assert.match(r.logged.join('\n'), /ENOSPC/);
    assert.match(r.logged.join('\n'), /re-attach: RE\n {2}collect: {3}COLLECT/);
    assert.equal(r.ssh.filter(([, c]) => /--detach/.test(c)).length, name === '--collect-only emits' ? 0 : 1);
  });
}

test('a throw before the launch (the report check) is not a post-launch case: hostRun rejects', async () => {
  await assert.rejects(hostRun({ name: 'box', host: box, stateDir, localState: '/l', run: { ssh: boom }, emit() {}, log() {}, sleep: async () => {}, reattach: 'RE', collect: 'COLLECT' }), /ENOSPC/);
});

for (const [name, replies, nextCalls, opts] of [
  ['the launch', [FRESH, { status: 255, stdout: '', stderr: 'ssh: connect timed out' }], 2],
  ['a poll', [FRESH, LAUNCHED, { status: 255, stdout: '', stderr: '' }], 3],
  ['a poll that timed out', [FRESH, LAUNCHED, failedToRun('ETIMEDOUT')], 3],
  ['--collect-only polling', [{ status: 255, stdout: '', stderr: '' }], 1, { collectOnly: true }],
]) {
  test(`ssh dropping at ${name} exits 255 with the re-attach and collect commands, not as an engine failure`, async () => {
    const r = await go(replies, opts);
    assert.equal(r.code, 255);
    assert.equal(r.ssh.length, nextCalls);
    assert.match(r.logged.join('\n'), /connection dropped.*not an engine failure.*RE.*COLLECT/s);
    assert.equal(r.rsync.length, 0);
  });
}

for (const [name, replies, opts] of [
  ['the pre-launch report check', [{ status: 255, stdout: '', stderr: '' }], {}],
  ['--plan', [{ status: 255, stdout: '', stderr: '' }], { plan: true }],
]) {
  test(`ssh dropping at ${name}, before any engine starts, exits 3 reporting only the drop`, async () => {
    const r = await go(replies, opts);
    assert.equal(r.code, 3);
    assert.equal(r.ssh.length, 1);
    assert.match(r.logged.join('\n'), /connection dropped.*no engine was started/s);
    assert.doesNotMatch(r.logged.join('\n'), /may still be running|re-attach|COLLECT|RE/);
    assert.equal(r.rsync.length, 0);
  });
}

for (const [name, replies, rsyncReply, expected] of [
  ['a report check whose ssh is missing', [failedToRun('ENOENT')], undefined, /report check.*ENOENT/],
  ['a report check whose output overflowed', [failedToRun('ENOBUFS')], undefined, /report check.*ENOBUFS/],
  ['a launch whose output overflowed', [FRESH, failedToRun('ENOBUFS')], undefined, /launch.*ENOBUFS/],
  ['a poll whose output overflowed', [FRESH, LAUNCHED, failedToRun('ENOBUFS')], undefined, /polling.*ENOBUFS/],
  ['an rsync that could not start', [FRESH, LAUNCHED, poll(0, 1)], { status: null, stderr: '', error: new Error('spawnSync rsync ENOENT') }, /rsync.*ENOENT/],
]) {
  test(`${name} exits 1 naming the error, not as a dropped connection`, async () => {
    const r = await go(replies, rsyncReply && { rsyncReply });
    assert.equal(r.code, 1);
    assert.match(r.logged.join('\n'), expected);
    assert.doesNotMatch(r.logged.join('\n'), /dropped/);
  });
}

for (const [name, launch, expected] of [
  ['fails', { status: 1, stdout: 'Detached orchestrator already running (PID 5)\n', stderr: '' }, /ssh exited 1/],
  ['exits 0 but prints no pid', { status: 0, stdout: 'started\n', stderr: '' }, /no PID/],
]) {
  test(`a launch that ${name} exits 1 and polls nothing`, async () => {
    const r = await go([FRESH, launch]);
    assert.equal(r.code, 1);
    assert.equal(r.ssh.length, 2);
    assert.match(r.logged.join('\n'), expected);
    assert.equal(r.rsync.length, 0);
  });
}

test('a failed rsync exits 1 even when a report was written', async () => {
  const r = await go([FRESH, LAUNCHED, poll(0, 1)], { rsyncReply: { status: 23, stderr: '' } });
  assert.equal(r.code, 1);
  assert.match(r.logged.join('\n'), /rsync exited 23/);
});

test('a log chunk at the cap is read on at once, without a sleep, before the run ends', async () => {
  const big = `${'a'.repeat(LOG_CHUNK - 1)}\n`;
  const r = await go([FRESH, LAUNCHED, poll(0, 1, big), poll(0, 1, 'end\n')]);
  assert.equal(r.code, 0);
  assert.equal(r.slept, 0);
  assert.match(r.ssh[3][1], new RegExp(`tail -c \\+${LOG_CHUNK + 1} `));
  assert.equal(r.emitted, `${LAUNCHED.stdout}${big}end\n`);
});

test('the log offset advances by the raw bytes read, not by their UTF-8 decoding', async () => {
  const r = await go([FRESH, LAUNCHED, poll(1, 0, Buffer.from([0x61, 0xff, 0x0a])), poll(0, 1)]);
  assert.equal(r.code, 0);
  assert.match(r.ssh[3][1], /tail -c \+4 /);
});

test('a report that appears while the engine runs ends the wait one poll later, so its digests can land', async () => {
  const r = await go([FRESH, LAUNCHED, poll(1, 0), poll(1, 1, 'report\n'), poll(1, 1, 'digests\n')]);
  assert.equal(r.code, 0);
  assert.equal(r.ssh.length, 5);
  assert.equal(r.slept, 2);
  assert.equal(r.rsync.length, 1);
});

test('a run refuses to launch on a host state dir that already holds a report, starting and collecting nothing', async () => {
  const r = await go([{ status: 0, stdout: 'reports= 1\n', stderr: '' }]);
  assert.equal(r.code, 1);
  assert.equal(r.ssh.length, 1);
  assert.match(r.logged.join('\n'), /boxssh:\/h\/\.local\/state\/ship-dag\/engine\/run1 already holds a report.*each wave needs its own state dir.*<runId>-w<N>.*started nothing/s);
  assert.equal(r.rsync.length, 0);
});

for (const [name, dir] of [['a space', '/h/run 1'], ['a quote', "/h/o'run"], ['a glob', '/h/run*'], ['a dollar', '/h/$run']]) {
  for (const mode of ['run', 'collectOnly', 'plan']) {
    test(`a host state dir with ${name} is refused before any ssh call (${mode})`, async () => {
      const r = await go([], { stateDir: dir, [mode]: true });
      assert.equal(r.code, 1);
      assert.equal(r.ssh.length, 0);
      assert.match(r.logged.join('\n'), /\[A-Za-z0-9\._\/@\+-\].*rsync/s);
      assert.equal(r.rsync.length, 0);
    });
  }
}

test('an engine still running at --max-wait stops the wait with exit 4 and the --collect-only command, collecting nothing', async () => {
  const r = await go([FRESH, LAUNCHED, poll(1, 0), poll(1, 0), poll(1, 0)], { maxWaitMs: 2 * MINUTE });
  assert.equal(r.code, 4);
  assert.equal(r.ssh.length, 5);
  assert.match(r.logged.join('\n'), /still running after 2 minutes.*COLLECT/s);
  assert.equal(r.rsync.length, 0);
});

for (const [name, replies, expected] of [
  ['a state dir that already holds reports: no refusal, one poll of the whole log, then the collect', [poll(0, 2, 'old log\n')], { code: 0, polls: 1, slept: 0, emitted: 'old log\n', logged: /^$/ }],
  ['a run still going: it waits for the engine, then collects', [poll(1, 0, 'a\n'), poll(1, 0, 'b\n'), poll(0, 1, 'c\n')], { code: 0, polls: 3, slept: 2, emitted: 'a\nb\nc\n', logged: /^$/ }],
  ['no pid file: it says so instead of claiming the engine exited', [poll('none', 0)], { code: 1, polls: 1, slept: 0, emitted: '', logged: /no \/h\/.*\/run1\/host-run\.pid.*cannot tell/s }],
]) {
  test(`--collect-only starts nothing: ${name}`, async () => {
    const r = await go(replies, { collectOnly: true });
    assert.equal(r.code, expected.code);
    assert.equal(r.ssh.length, expected.polls);
    assert.match(r.ssh[0][1], /^pid=\$\(cat .*tail -c \+1 /);
    assert.equal(r.slept, expected.slept);
    assert.equal(r.emitted, expected.emitted);
    assert.match(r.logged.join('\n'), expected.logged);
    assert.doesNotMatch(r.logged.join('\n'), /exited with no report/);
    assert.equal(r.rsync.length, 1);
  });
}

test('--preflight runs resource-preflight on the host under the engine env, emits only its stdout (the JSON), and starts and collects nothing', async () => {
  const r = await go([{ status: 0, stdout: '{"action":"proceed"}\n', stderr: 'resource: normal\n' }], { preflight: true, parallel: 8 });
  assert.equal(r.code, 0);
  assert.equal(r.ssh.length, 1);
  assert.equal(r.ssh[0][1], preflightCommand(box, 8));
  assert.match(r.ssh[0][1], /CO_LEASE_SESSION_SLOTS='1'.*resource-preflight\.mjs' check --parallel 1$/);
  assert.equal(r.emitted, '{"action":"proceed"}\n');
  assert.deepEqual(r.logged, ['resource: normal\n'.trimEnd()]);
  assert.equal(r.rsync.length, 0);
});

for (const [name, reply, code, message] of [
  ['an unreachable host exits 3: nothing started and nothing changed', { status: 255, stdout: '', stderr: '' }, 3, /nothing to resume/],
  ['a timed-out call exits 3', failedToRun('ETIMEDOUT'), 3, /nothing to resume/],
  ['a preflight that fails exits 1', { status: 1, stdout: '', stderr: 'boom' }, 1, /the preflight exited 1/],
]) {
  test(`--preflight: ${name}`, async () => {
    const r = await go([reply], { preflight: true });
    assert.equal(r.code, code);
    assert.match(r.logged.join('\n'), message);
    assert.equal(r.rsync.length, 0);
  });
}

test('--plan runs the read-only plan, streams it, and starts and collects nothing', async () => {
  const r = await go([{ status: 0, stdout: 'plan out\n', stderr: 'plan err\n' }], { plan: true });
  assert.equal(r.code, 0);
  assert.equal(r.ssh.length, 1);
  assert.match(r.ssh[0][1], / --plan$/);
  assert.equal(r.emitted, 'plan out\nplan err\n');
  assert.equal(r.rsync.length, 0);
});

/** Run `main` for host `box` against a scratch config and local state dir (its host log holding `log`, if given), with `ssh` answering from `replies`; returns the exit code, output and host log (undefined when absent). */
async function cli(args, replies, { hosts = { box }, log, relativePaths = false, repos, calls, profiles } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'host-run-cli-'));
  const config = join(dir, 'config.box.json');
  writeFileSync(config, JSON.stringify({ configDir: `${stateDir}/state`, worktreeDir: `${stateDir}/wt`, repos }));
  const state = join(dir, 'local');
  if (log !== undefined) { mkdirSync(state, { recursive: true }); writeFileSync(join(state, 'host-box.log'), log); }
  let out = '';
  let err = '';
  const run = { ssh: (alias, command) => (calls?.push(command), replies.shift()), rsync: () => ({ status: 0, stderr: '' }) };
  const path = (p) => (relativePaths ? relative(process.cwd(), p) : p);
  const code = await main(['box', path(config), '--state', path(state), ...args], { hosts, run, out: (s) => (out += s), err: (s) => (err += s), sleep: async () => {}, ...(profiles && { profiles }) });
  const logPath = join(state, 'host-box.log');
  return { code, out, err, stateMade: existsSync(state), log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : undefined };
}

for (const [name, args, replies, log, expected] of [
  ['a run appends to the host log', [], [FRESH, LAUNCHED, poll(0, 1, 'new\n')], 'earlier\n', `earlier\n${LAUNCHED.stdout}new\n`],
  ['--collect-only appends to the host log', ['--collect-only'], [poll(0, 1, 'again\n')], 'earlier\n', 'earlier\nagain\n'],
  ['--plan never touches the host log', ['--plan'], [{ status: 0, stdout: 'plan\n', stderr: '' }], undefined, undefined],
  ['--preflight never touches the host log', ['--preflight'], [{ status: 0, stdout: '{}\n', stderr: '' }], undefined, undefined],
]) {
  test(`main: ${name}`, async () => {
    const r = await cli(args, replies, { log });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.log, expected);
  });
}

test('main: --preflight prints the JSON with no host prefix, so the caller can parse it', async () => {
  const r = await cli(['--preflight', '--parallel', '3'], [{ status: 0, stdout: '{"action":"proceed"}\n', stderr: '' }]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '{"action":"proceed"}\n');
});

test('main: a dropped connection prints resume commands with the host and its ssh alias shell-quoted, absolute paths and the --max-wait', async () => {
  const r = await cli(['--max-wait', '30'], [FRESH, { status: 255, stdout: '', stderr: '' }], { hosts: { box: testHost('/h', {}, "o'box") }, relativePaths: true });
  assert.equal(r.code, 255);
  assert.match(r.err, /re-attach: ssh -o BatchMode=yes -o ConnectTimeout=10 'o'\\''box' '/);
  assert.match(r.err, /collect: +node '\/[^']*host-run\.mjs' 'box' '\/[^']*config\.box\.json' --state '\/[^']*local' --max-wait 30 --collect-only/);
});

// The entry wrapper's exit codes: a usage error is 2, any other throw before the launch is 1 (a broken registry or config file is not the command line's fault).
const BAD_CONFIG = join(mkdtempSync(join(tmpdir(), 'host-run-bad-')), 'config.json');
writeFileSync(BAD_CONFIG, JSON.stringify({ configDir: '/x', worktreeDir: '/y' }));
const entryArgs = (config, ...rest) => ['box', config, '--state', join(tmpdir(), 'host-run-entry'), ...rest];
for (const [name, argv, deps, expected, shown] of [
  ['an unknown option', ['box', 'c', '--state', 's', '--dryrun'], {}, 2, /unknown option --dryrun/],
  ['no arguments', [], {}, 2, /^usage: host-run\.mjs/],
  ['a missing --state', ['box', 'c'], {}, 2, /^usage: host-run\.mjs/],
  ['--state without a value', ['box', 'c', '--state'], {}, 2, /--state/],
  ['--max-wait without a value', ['box', 'c', '--state', 's', '--max-wait'], {}, 2, /--max-wait/],
  ['an unknown host', ['nope', 'c', '--state', 's'], { hosts: { box } }, 2, /unknown host "nope"; known: box/],
  ['a config that is not emit-config\'s', entryArgs(BAD_CONFIG), { hosts: { box } }, 2, /pass the config emit-config --by-host wrote/],
  ['an invalid hosts.json', entryArgs(BAD_CONFIG), { loadHosts: () => { throw new Error('hosts.json: bad'); } }, 1, /hosts\.json: bad/],
  ['a missing config file', entryArgs(join(tmpdir(), 'host-run-absent.json')), { hosts: { box } }, 1, /ENOENT/],
]) {
  test(`the CLI exits ${expected} for ${name}`, async () => {
    const lines = [];
    assert.equal(await entry(argv, { ...deps, err: (m) => lines.push(m), run: { ssh: boom, rsync: boom } }), expected);
    assert.match(lines.join(''), shown);
  });
}

test('the CLI exits 1 for a plain throw from the runner before the launch, and 255 for one after it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-run-entry-'));
  const config = join(dir, 'config.box.json');
  writeFileSync(config, JSON.stringify({ configDir: `${stateDir}/state`, worktreeDir: `${stateDir}/wt` }));
  const lines = [];
  const ssh = () => { throw new Error('spawn exploded'); };
  assert.equal(await entry(['box', config, '--state', join(dir, 'l')], { hosts: { box }, run: { ssh, rsync: boom }, err: (m) => lines.push(m), out() {}, sleep: async () => {} }), 1);
  assert.match(lines.join(''), /spawn exploded/);
  const replies = [FRESH, LAUNCHED];
  const after = await entry(['box', config, '--state', join(dir, 'l')], { hosts: { box }, run: { ssh: () => { const r = replies.shift(); if (!r) throw new Error('disk full'); return r; }, rsync: boom }, err: (m) => lines.push(m), out() {}, sleep: async () => {} });
  assert.equal(after, 255);
  assert.match(lines.join(''), /disk full[^]*--collect-only/);
});

test('main: --max-wait must be a positive number of minutes', async () => {
  await assert.rejects(cli(['--max-wait', '0'], []), /--max-wait must be >= 1/);
});

const FAKE_SSH = '#!/bin/sh\n# Drop the -o options and the alias, then run the remote command here.\nwhile [ "$1" = -o ]; do shift 2; done\nshift\nexec /bin/sh -c "$1"\n';

test('realRunner: a poll of a log far over the cap comes back capped and is not read as a drop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-run-ssh-'));
  writeFileSync(join(dir, 'ssh'), FAKE_SSH, { mode: 0o755 });
  mkdirSync(join(dir, 'run1', 'state', 'logs'), { recursive: true });
  writeFileSync(join(dir, 'run1', 'state', 'logs', 'orchestrator.log'), 'x'.repeat(3 * 1024 * 1024));
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    const r = realRunner().ssh('box', pollScript(join(dir, 'run1'), 0));
    assert.equal(r.error, undefined);
    assert.equal(r.status, 0);
    assert.equal(parsePoll(r.stdout).log.length, LOG_CHUNK);
  } finally {
    process.env.PATH = path;
  }
});

const HAVE_RSYNC = spawnSync('rsync', ['--version']).status === 0;
const DIAGNOSE = fileURLToPath(new URL('./diagnose-failure.mjs', import.meta.url));

test('diagnose-failure and rate-limit-preflight read a collected stateDir as they read the remote one', { skip: !HAVE_RSYNC }, () => {
  const REF = 'o/app#2';
  const event = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.42, resetsAt: 1788724800 } });
  const remote = scopedEngineFixture({ run1: {
    reports: { '2026-10-21T10-00-00.000Z.json': { configName: 'ship-dag-run1', startedAt: '2026-10-21T10:00:00.000Z', issues: [{ ref: REF, number: 2, status: 'failed', ran: true }] } },
    digests: [{ ref: REF, body: { ref: REF, route: 'implement-stall', reason: 'stalled' } }],
    files: { [`state/logs/issue-${encodeURIComponent(REF)}.log`]: `${event}\n` },
  } }).dirs.run1;
  const base = mkdtempSync(join(tmpdir(), 'host-run-base-'));
  mkdirSync(join(base, 'run1', 'state'), { recursive: true });
  const r = spawnSync('rsync', rsyncArgs(`${remote}/state/`, `${base}/run1/state/`), { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // The output names the digest's path, so compare it with the state dir taken out.
  const diagnose = (dir) => { const d = spawnSync(process.execPath, [DIAGNOSE, REF, '--state-dir', dir], { encoding: 'utf8' }); return [d.status, d.stdout.replaceAll(dir, '<dir>')]; };
  assert.deepEqual(diagnose(join(base, 'run1')), diagnose(remote));
  assert.equal(readLatestUtilization(base).utilization, 0.42);
});

// A wave that holds an Xcode repo runs one session at a time, however many slots the host has and whatever --parallel says.
const TWO = testHost('/h', { sessionSlots: 2 }, 'boxssh');
const IOS = { 'o/ios': { baseBranch: 'main', postSessionCheck: { commands: ['xcodebuild test -scheme A'] } } };
const NODE = { 'o/app': { baseBranch: 'main', postSessionCheck: { commands: ['npm test'] } } };
const HIDDEN = { 'o/hidden': { baseBranch: 'main', postSessionCheck: { commands: ['scripts/test-affected.sh'] } } };
const flagsOf = (calls) => /--parallel (\d+) --detach/.exec(calls.find((c) => c.includes('--detach')))?.[1];

for (const [name, args, repos, profiles, parallel, clamped] of [
  ['an Xcode repo with no --parallel', [], IOS, {}, '1', true],
  ['an Xcode repo with --parallel 2', ['--parallel', '2'], IOS, {}, '1', true],
  ['an Xcode repo with --parallel 1 needs no clamp', ['--parallel', '1'], IOS, {}, '1', false],
  ['an Xcode repo declared by its profile, its command hiding xcodebuild', [], HIDDEN, { 'o/hidden': { toolchains: ['xcode'] } }, '1', true],
  ['a node-only config with no --parallel keeps the host slots', [], NODE, {}, '2', false],
  ['a node-only config with --parallel 2', ['--parallel', '2'], NODE, {}, '2', false],
  ['a mixed config is serialized too', [], { ...NODE, ...IOS }, {}, '1', true],
]) {
  test(`main: ${name}`, async () => {
    const calls = [];
    const r = await cli(args, [FRESH, LAUNCHED, poll(0, 1)], { hosts: { box: TWO }, repos, calls, profiles });
    assert.equal(r.code, 0, r.err);
    assert.equal(flagsOf(calls), parallel);
    assert.equal(/clamping --parallel from 2 to 1/.test(r.err), clamped, r.err);
  });
}

// --worktree/--base: one read of a host worktree through the runner, before anything is launched.
const WORKTREE = ['--worktree', '/h/wt/app-1', '--base', 'main'];
for (const [name, reply, code, out, err] of [
  ['a worktree with commits and a dirty tree', { status: 0, stdout: 'exists=1\ncommits=2\ndirty=1\n', stderr: '' }, 0, '{"exists":true,"commits":2,"dirty":true}\n', ''],
  ['a missing worktree is a successful read', { status: 0, stdout: 'exists=0\n', stderr: '' }, 0, '{"exists":false,"commits":0,"dirty":false}\n', ''],
  ['ssh exiting 255 is a drop', { status: 255, stdout: '', stderr: '' }, 3, '', /ssh connection dropped/],
  ['a timed-out call is a drop', failedToRun('ETIMEDOUT'), 3, '', /ssh connection dropped/],
  ['a failing remote command', { status: 1, stdout: 'exists=1\ncommits=2\ndirty=0\n', stderr: 'fatal: bad revision' }, 1, '', /the worktree read exited 1.*bad revision/s],
  ['output with no recognizable lines', { status: 0, stdout: 'hello\n', stderr: '' }, 1, '', /no worktree state/],
  ['an overflowed buffer', failedToRun('ENOBUFS'), 1, '', /ENOBUFS/],
]) {
  test(`main --worktree: ${name}`, async () => {
    const calls = [];
    const r = await cli(WORKTREE, [reply], { calls });
    assert.equal(r.code, code, r.err);
    assert.equal(r.out, out);
    if (err) assert.match(r.err, err); else assert.equal(r.err, '');
    assert.deepEqual(calls, [worktreeScript('/h/wt/app-1', 'main')]);
  });
}

test('main --worktree is read-only: no state dir, no host log, an existing host log untouched', async () => {
  const fresh = await cli(WORKTREE, [{ status: 0, stdout: 'exists=1\ncommits=0\ndirty=0\n', stderr: '' }]);
  assert.equal(fresh.stateMade, false);
  assert.equal(fresh.log, undefined);
  const kept = await cli(WORKTREE, [{ status: 0, stdout: 'exists=0\n', stderr: '' }], { log: 'earlier\n' });
  assert.equal(kept.log, 'earlier\n');
});

for (const [name, args, shown] of [
  ['--worktree without --base', ['--worktree', '/w'], /--worktree and --base/],
  ['--base without --worktree', ['--base', 'main'], /--worktree and --base/],
  ['--worktree without a value', ['--worktree', '--base', 'main'], /--worktree/],
  ['--base without a value', ['--worktree', '/w', '--base'], /--base/],
]) {
  test(`the CLI exits 2 for ${name}`, async () => {
    const lines = [];
    const config = join(mkdtempSync(join(tmpdir(), 'host-run-wt-')), 'c.json');
    writeFileSync(config, JSON.stringify({ configDir: `${stateDir}/state`, worktreeDir: `${stateDir}/wt` }));
    assert.equal(await entry(['box', config, '--state', 's', ...args], { hosts: { box }, run: { ssh: boom, rsync: boom }, err: (m) => lines.push(m) }), 2);
    assert.match(lines.join(''), shown);
  });
}

test('the CLI exits 1, never 255 or a --collect-only resume, when the worktree read throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-run-wt-'));
  const config = join(dir, 'config.box.json');
  writeFileSync(config, JSON.stringify({ configDir: `${stateDir}/state`, worktreeDir: `${stateDir}/wt` }));
  const lines = [];
  const ssh = () => { throw new Error('spawn exploded'); };
  assert.equal(await entry(['box', config, '--state', join(dir, 'l'), ...WORKTREE], { hosts: { box }, run: { ssh, rsync: boom }, err: (m) => lines.push(m), out() {} }), 1);
  assert.match(lines.join(''), /spawn exploded/);
  assert.doesNotMatch(lines.join(''), /collect-only/);
  assert.equal(existsSync(join(dir, 'l')), false);
});

// The four modes are alternatives: any two together exit 2 naming both, before an ssh call (the runner throws if called).
const MODE_FLAGS = [['--plan'], ['--preflight'], ['--collect-only'], WORKTREE];
for (const [i, a] of MODE_FLAGS.entries()) {
  for (const b of MODE_FLAGS.slice(i + 1)) {
    test(`the CLI exits 2 for ${a[0]} with ${b[0]}, naming both and making no call`, async () => {
      const lines = [];
      const config = join(mkdtempSync(join(tmpdir(), 'host-run-modes-')), 'c.json');
      writeFileSync(config, JSON.stringify({ configDir: `${stateDir}/state`, worktreeDir: `${stateDir}/wt` }));
      assert.equal(await entry(['box', config, '--state', 's', ...a, ...b], { hosts: { box }, run: { ssh: boom, rsync: boom }, err: (m) => lines.push(m) }), 2);
      const shown = lines.join('');
      assert.ok(shown.includes(a[0]) && shown.includes(b[0]), shown);
    });
  }
}
