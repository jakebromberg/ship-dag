// Tests for the host-run flow. The runner is injected, so no test opens a connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostRun, main, realRunner } from './host-run.mjs';
import { readLatestUtilization } from './rate-limit-preflight.mjs';
import { LOG_CHUNK, parsePoll, pollScript, rsyncArgs } from './lib/host-run.mjs';
import { scopedEngineFixture } from './lib/engine-fixture.mjs';
import { testHost } from './lib/test-host.mjs';

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

test('--plan runs the read-only plan, streams it, and starts and collects nothing', async () => {
  const r = await go([{ status: 0, stdout: 'plan out\n', stderr: 'plan err\n' }], { plan: true });
  assert.equal(r.code, 0);
  assert.equal(r.ssh.length, 1);
  assert.match(r.ssh[0][1], / --plan$/);
  assert.equal(r.emitted, 'plan out\nplan err\n');
  assert.equal(r.rsync.length, 0);
});

/** Run `main` for host `box` against a scratch config and local state dir (its host log holding `log`, if given), with `ssh` answering from `replies`; returns the exit code, output and host log (undefined when absent). */
async function cli(args, replies, { hosts = { box }, log, relativePaths = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'host-run-cli-'));
  const config = join(dir, 'config.box.json');
  writeFileSync(config, JSON.stringify({ configDir: `${stateDir}/state`, worktreeDir: `${stateDir}/wt` }));
  const state = join(dir, 'local');
  if (log !== undefined) { mkdirSync(state, { recursive: true }); writeFileSync(join(state, 'host-box.log'), log); }
  let out = '';
  let err = '';
  const run = { ssh: () => replies.shift(), rsync: () => ({ status: 0, stderr: '' }) };
  const path = (p) => (relativePaths ? relative(process.cwd(), p) : p);
  const code = await main(['box', path(config), '--state', path(state), ...args], { hosts, run, out: (s) => (out += s), err: (s) => (err += s), sleep: async () => {} });
  const logPath = join(state, 'host-box.log');
  return { code, out, err, log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : undefined };
}

for (const [name, args, replies, log, expected] of [
  ['a run appends to the host log', [], [FRESH, LAUNCHED, poll(0, 1, 'new\n')], 'earlier\n', `earlier\n${LAUNCHED.stdout}new\n`],
  ['--collect-only appends to the host log', ['--collect-only'], [poll(0, 1, 'again\n')], 'earlier\n', 'earlier\nagain\n'],
  ['--plan never touches the host log', ['--plan'], [{ status: 0, stdout: 'plan\n', stderr: '' }], undefined, undefined],
]) {
  test(`main: ${name}`, async () => {
    const r = await cli(args, replies, { log });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.log, expected);
  });
}

test('main: a dropped connection prints resume commands with the host and its ssh alias shell-quoted, absolute paths and the --max-wait', async () => {
  const r = await cli(['--max-wait', '30'], [FRESH, { status: 255, stdout: '', stderr: '' }], { hosts: { box: testHost('/h', {}, "o'box") }, relativePaths: true });
  assert.equal(r.code, 255);
  assert.match(r.err, /re-attach: ssh -o BatchMode=yes -o ConnectTimeout=10 'o'\\''box' '/);
  assert.match(r.err, /collect: +node '\/[^']*host-run\.mjs' 'box' '\/[^']*config\.box\.json' --state '\/[^']*local' --max-wait 30 --collect-only/);
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
