// Tests for the host-run flow. The runner is injected, so no test opens a connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostRun } from './host-run.mjs';
import { readLatestUtilization } from './rate-limit-preflight.mjs';
import { rsyncArgs } from './lib/host-run.mjs';
import { scopedEngineFixture } from './lib/engine-fixture.mjs';
import { validateHosts } from './lib/hosts.mjs';

const { box } = validateHosts({ box: { ssh: 'boxssh', home: '/h', reposDir: '/h/D', sdHome: '/h/D/ship-dag' } });
const stateDir = '/h/.local/state/ship-dag/engine/run1';
const LAUNCHED = { status: 0, stdout: 'Detached orchestrator (PID 77)\nLog: /l\n', stderr: '' };
const poll = (alive, reports, log = '') => ({ status: 0, stdout: `alive=${alive}\nreports=${reports}\n---\n${log}`, stderr: '' });

/** Run `hostRun` with `ssh` answering from `replies` in order (rsync from `rsyncStatus`); returns what it did. */
async function go(replies, { rsyncStatus = 0, ...opts } = {}) {
  const calls = { ssh: [], rsync: [], emitted: '', logged: [] };
  const run = {
    ssh: (alias, command) => (calls.ssh.push([alias, command]), replies.shift()),
    rsync: (args) => (calls.rsync.push(args), { status: rsyncStatus, stderr: '' }),
  };
  const code = await hostRun({ name: 'box', host: box, stateDir, localState: '/l', run, emit: (t) => (calls.emitted += t), log: (m) => calls.logged.push(m), sleep: async () => {}, reattach: 'RE', collect: 'COLLECT', ...opts });
  return { code, ...calls };
}

test('a run launches detached, polls until the engine exits with a report, then collects and exits 0', async () => {
  const r = await go([LAUNCHED, poll(1, 0, 'one\n'), poll(1, 0, 'two\npart'), poll(0, 1, 'partial\n')]);
  assert.equal(r.code, 0);
  assert.match(r.ssh[0][1], /--parallel 1 --detach$/);
  assert.match(r.ssh[2][1], /tail -c \+5 /);
  assert.match(r.ssh[3][1], /tail -c \+9 /);
  assert.equal(r.emitted, `${LAUNCHED.stdout}one\ntwo\npartial\n`);
  assert.equal(r.rsync.length, 1);
  assert.deepEqual(r.rsync[0].slice(-2), [`boxssh:${stateDir}/state/`, '/l/state/']);
  assert.deepEqual(r.logged, []);
});

test('an engine that exits with no report exits 1 naming the remote log, and still collects', async () => {
  const r = await go([LAUNCHED, poll(0, 0)]);
  assert.equal(r.code, 1);
  assert.match(r.logged.join('\n'), /no report; see boxssh:\/h\/\.local\/state\/ship-dag\/engine\/run1\/state\/logs\/orchestrator\.log/);
  assert.equal(r.rsync.length, 1);
});

for (const [name, replies, nextCalls] of [
  ['the launch', [{ status: 255, stdout: '', stderr: 'ssh: connect timed out' }], 1],
  ['a poll', [LAUNCHED, { status: 255, stdout: '', stderr: '' }], 2],
  ['a poll that timed out', [LAUNCHED, { status: null, stdout: '', stderr: '' }], 2],
]) {
  test(`ssh dropping at ${name} exits 255 with the re-attach and collect commands, not as an engine failure`, async () => {
    const r = await go(replies);
    assert.equal(r.code, 255);
    assert.equal(r.ssh.length, nextCalls);
    assert.match(r.logged.join('\n'), /connection dropped.*not an engine failure.*RE.*COLLECT/s);
    assert.equal(r.rsync.length, 0);
  });
}

test('a launch that fails or prints no pid exits 1 and polls nothing', async () => {
  const r = await go([{ status: 1, stdout: '', stderr: 'Detached orchestrator already running (PID 5)\n' }]);
  assert.equal(r.code, 1);
  assert.equal(r.ssh.length, 1);
  assert.match(r.emitted, /already running/);
});

test('a failed rsync exits 1 even when a report was written', async () => {
  const r = await go([LAUNCHED, poll(0, 1)], { rsyncStatus: 23 });
  assert.equal(r.code, 1);
  assert.match(r.logged.join('\n'), /rsync exited 23/);
});

test('--collect-only starts nothing: one poll of the whole log, then the collect', async () => {
  const r = await go([poll(0, 2, 'old log\n')], { collectOnly: true });
  assert.equal(r.code, 0);
  assert.equal(r.ssh.length, 1);
  assert.match(r.ssh[0][1], /^echo alive=0; .*tail -c \+1 /);
  assert.equal(r.emitted, 'old log\n');
  assert.equal(r.rsync.length, 1);
});

test('--plan runs the read-only plan, streams it, and starts and collects nothing', async () => {
  const r = await go([{ status: 0, stdout: 'plan out\n', stderr: 'plan err\n' }], { plan: true });
  assert.equal(r.code, 0);
  assert.match(r.ssh[0][1], / --plan$/);
  assert.equal(r.emitted, 'plan out\nplan err\n');
  assert.equal(r.rsync.length, 0);
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
