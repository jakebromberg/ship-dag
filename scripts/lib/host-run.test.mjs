// Tests for the host-run pure helpers. No test opens a connection; the collect test runs rsync between two local dirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { testHost } from './host-fixture.mjs';
import { LOG_CHUNK, PID_FILE, engineCommand, launchScript, leaseEnv, preflightCommand, outcome, parsePoll, parseReports, pollDecision, pollScript, prefixLines, reportsScript, rsyncArgs } from './host-run.mjs';

const box = testHost();
const big = testHost('/b', { coHome: '/b/co', sessionSlots: 3, leaseSlots: 5 }, 'big');
const stateDir = '/h/.local/state/ship-dag/engine/run1';
const put = (root, rel, body) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const env = (h, slots) => `SHIP_DAG_CONFIG='${stateDir}/config.json' SHIP_DAG_PROJECT_ROOT='${h.reposDir}' CO_HOME='${h.coHome}' CO_LEASE_HOOK='on' CO_LEASE_SESSION_SLOTS='${slots[0]}' CO_LEASE_SLOTS='${slots[1]}'`;
const run = (h) => `npx --prefix '${h.coHome}' tsx '${h.sdHome}/scripts/engine/run.mts' wave`;

for (const [name, h, mode, parallel, expected] of [
  ['a detached run, slots default to 1 and parallel to the cap', box, 'run', undefined, `${env(box, [1, 1])} ${run(box)} --parallel 1 --detach`],
  ['a detached run capped at sessionSlots', big, 'run', 8, `${env(big, [3, 5])} ${run(big)} --parallel 3 --detach`],
  ['a detached run below the cap', big, 'run', 2, `${env(big, [3, 5])} ${run(big)} --parallel 2 --detach`],
  ['--plan', big, 'plan', 8, `${env(big, [3, 5])} ${run(big)} --plan`],
  ['the re-attach command', big, 'tail', undefined, `${env(big, [3, 5])} ${run(big)} --tail`],
]) {
  test(`engineCommand: ${name}`, () => {
    assert.equal(engineCommand(h, stateDir, mode, parallel), expected);
  });
}

for (const [name, h, expected] of [
  ['slots default to 1', box, { CO_HOME: box.coHome, CO_LEASE_HOOK: 'on', CO_LEASE_SESSION_SLOTS: 1, CO_LEASE_SLOTS: 1 }],
  ['slots and coHome from hosts.json', big, { CO_HOME: '/b/co', CO_LEASE_HOOK: 'on', CO_LEASE_SESSION_SLOTS: 3, CO_LEASE_SLOTS: 5 }],
]) {
  test(`leaseEnv: ${name}`, () => {
    assert.deepEqual(leaseEnv(h), expected);
  });
}

for (const [name, h, parallel] of [['slots default to 1', box, undefined], ['capped at sessionSlots', big, 8], ['below the cap', big, 2]]) {
  test(`preflightCommand: ${name} runs under the env engineCommand builds`, () => {
    const lease = engineCommand(h, stateDir, 'run', parallel).match(/CO_HOME=.*?CO_LEASE_SLOTS='\d+'/)[0];
    const cap = Math.min(parallel ?? h.sessionSlots ?? 1, h.sessionSlots ?? 1);
    assert.equal(preflightCommand(h, parallel), `${lease} node '${h.sdHome}/scripts/resource-preflight.mjs' check --parallel ${cap}`);
  });
}

for (const [name, kind, ctx, expected] of [
  ['a report was written', 'done', {}, { code: 0, message: undefined }],
  ['no report', 'no-report', { engineLog: 'box:/l/orchestrator.log' }, { code: 1, message: /exited with no report; see box:\/l\/orchestrator\.log/ }],
  ['a dropped connection (255)', 'dropped', { reattach: 'RE', collect: 'COLLECT' }, { code: 255, message: /connection dropped.*may still be running.*RE.*COLLECT/s }],
  ['a drop before any engine started', 'dropped-unstarted', { step: 'the plan', reattach: 'RE', collect: 'COLLECT' }, { code: 3, message: /connection dropped during the plan; no engine was started, so there is nothing to resume/ }],
  ['a failed step', 'failed', { detail: 'rsync exited 23' }, { code: 1, message: /rsync exited 23/ }],
  ['no pid file', 'no-pid', { pidFile: '/s/host-run.pid' }, { code: 1, message: /no \/s\/host-run\.pid.*cannot tell whether the engine is still running/s }],
  ['the deadline passed', 'timeout', { minutes: 360, collect: 'COLLECT' }, { code: 4, message: /still running after 360 minutes.*not an engine failure.*COLLECT/s }],
]) {
  test(`outcome: ${name}`, () => {
    const o = outcome('box', kind, ctx);
    assert.equal(o.code, expected.code);
    if (expected.message) assert.match(o.message, expected.message); else assert.equal(o.message, undefined);
  });
}

for (const [name, out, expected] of [
  ['alive with a log chunk', 'alive=1\nreports=0\n---\nhello\n', { alive: true, reports: 0, log: 'hello\n' }],
  ['exited, padded count, empty log', 'alive=0\nreports=       2\n---\n', { alive: false, reports: 2, log: '' }],
  ['no pid file', 'alive=none\nreports=0\n---\n', { alive: null, reports: 0, log: '' }],
  ['a log chunk containing the marker', 'alive=0\nreports=1\n---\na\n---\nb\n', { alive: false, reports: 1, log: 'a\n---\nb\n' }],
  ['raw bytes stay raw', Buffer.concat([Buffer.from('alive=1\nreports=0\n---\n'), Buffer.from([0xff, 0x0a])]), { alive: true, reports: 0, log: Buffer.from([0xff, 0x0a]) }],
]) {
  test(`parsePoll: ${name}`, () => {
    assert.deepEqual(parsePoll(out), { ...expected, log: Buffer.from(expected.log) });
  });
}

for (const [name, p, reportSeen, expected] of [
  ['the engine is alive with no report', { alive: true, reports: 0 }, false, 'wait'],
  ['a report first seen while it is alive (its digests follow)', { alive: true, reports: 1 }, false, 'wait'],
  ['a report seen a poll ago and it is still alive', { alive: true, reports: 1 }, true, 'done'],
  ['it exited with a report', { alive: false, reports: 1 }, false, 'done'],
  ['it exited without one', { alive: false, reports: 0 }, false, 'no-report'],
  ['no pid file, a report', { alive: null, reports: 1 }, false, 'done'],
  ['no pid file, no report', { alive: null, reports: 0 }, false, 'no-pid'],
]) {
  test(`pollDecision: ${name}`, () => {
    assert.equal(pollDecision(p, reportSeen), expected);
  });
}

for (const [name, offset, expected] of [
  ['from the start', 0, /tail -c \+1 '\/h\/\.local\/state\/ship-dag\/engine\/run1\/state\/logs\/orchestrator\.log' 2>\/dev\/null \| head -c 262144/],
  ['from an offset', 10, /tail -c \+11 /],
  ['the pid comes from the pid file host-run wrote at launch', 0, /^pid=\$\(cat '\/h\/\.local\/state\/ship-dag\/engine\/run1\/host-run\.pid' 2>\/dev\/null\); .*kill -0 "\$pid".*reports'\/\*\.json/s],
]) {
  test(`pollScript: ${name}`, () => {
    assert.match(pollScript(stateDir, offset), expected);
  });
}

const sh = (script) => spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
const scratch = () => mkdtempSync(join(tmpdir(), 'host-run-sh-'));

for (const [name, command, status, pid] of [
  ['a started engine records its pid', `echo 'Detached orchestrator (PID 4242)'; echo 'Log: /x'`, 0, '4242\n'],
  ['a launch that prints no pid records none', 'echo started', 0, undefined],
  ['an engine already running records none and keeps its exit', `echo 'Detached orchestrator already running (PID 5)' >&2; exit 1`, 1, undefined],
]) {
  test(`launchScript: ${name}`, () => {
    const dir = scratch();
    const r = sh(launchScript(command, `${dir}/${PID_FILE}`));
    assert.equal(r.status, status);
    assert.match(r.stdout, /orchestrator|started/);
    assert.equal(existsSync(`${dir}/${PID_FILE}`) ? readFileSync(`${dir}/${PID_FILE}`, 'utf8') : undefined, pid);
  });
}

for (const [name, pid, logBytes, expected] of [
  ['a live pid, a log over the cap: one chunk of LOG_CHUNK bytes', String(process.pid), LOG_CHUNK * 5, { alive: true, reports: 1, size: LOG_CHUNK }],
  ['a dead pid, a short log', '999999', 3, { alive: false, reports: 1, size: 3 }],
  ['no pid file', undefined, 0, { alive: null, reports: 1, size: 0 }],
]) {
  test(`pollScript runs: ${name}`, () => {
    const dir = scratch();
    put(`${dir}/state`, 'reports/r.json', '{}');
    put(`${dir}/state`, 'logs/orchestrator.log', 'x'.repeat(logBytes));
    if (pid) writeFileSync(`${dir}/${PID_FILE}`, `${pid}\n`);
    const r = spawnSync('/bin/sh', ['-c', pollScript(dir, 0)], { maxBuffer: LOG_CHUNK * 2 });
    assert.equal(r.status, 0, String(r.stderr));
    const p = parsePoll(r.stdout);
    assert.deepEqual({ alive: p.alive, reports: p.reports, size: p.log.length }, expected);
  });
}

for (const [name, files, expected] of [
  ['no reports dir', [], 0],
  ['an empty reports dir', ['reports/.keep'], 0],
  ['two reports', ['reports/a.json', 'reports/b.json'], 2],
]) {
  test(`reportsScript runs: ${name}`, () => {
    const dir = scratch();
    for (const f of files) put(`${dir}/state`, f, '{}');
    const r = sh(reportsScript(dir));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(parseReports(r.stdout), expected);
  });
}

for (const [name, text, expected] of [
  ['two lines', 'a\nb\n', '[box] a\n[box] b\n'],
  ['no trailing newline', 'a', '[box] a\n'],
  ['a blank line in the middle', 'a\n\nb\n', '[box] a\n[box] \n[box] b\n'],
  ['nothing', '', ''],
]) {
  test(`prefixLines: ${name}`, () => {
    assert.equal(prefixLines('box', text), expected);
  });
}

const REPORT = '{"rows":[{"ref":"o/app#1","number":1,"wave":"2","status":"succeeded","prUrl":"https://github.com/o/app/pull/9","prNumber":9,"ran":true,"sessionIds":["s1"]}]}\n';
const HAVE_RSYNC = spawnSync('rsync', ['--version']).status === 0;

test('rsyncArgs: collects the per-issue and per-report files byte-identical and never the local engine\'s own files', { skip: !HAVE_RSYNC }, () => {
  const remote = mkdtempSync(join(tmpdir(), 'host-run-remote-'));
  const local = mkdtempSync(join(tmpdir(), 'host-run-local-'));
  const collected = ['reports/2026-10-21T10-00-00.000Z.json', 'failure-digest/issue-o%2Fapp%232.json', 'status/1.json', 'metadata/1.json', 'logs/issue-o%2Fapp%231.log'];
  for (const f of collected) put(`${remote}/state`, f, f === collected[0] ? REPORT : `remote ${f}\n`);
  for (const f of ['orchestrator.pid', 'logs/orchestrator.log', 'runs/r.json', 'counters/c.json', 'logs/other.txt', 'ship-dag-wave.jsonl']) put(`${remote}/state`, f, `remote ${f}\n`);
  const mine = ['orchestrator.pid', 'logs/orchestrator.log', 'runs/r.json', 'counters/c.json'];
  for (const f of mine) put(`${local}/state`, f, `local ${f}\n`);
  const r = spawnSync('rsync', rsyncArgs(`${remote}/state/`, `${local}/state/`), { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const f of collected) assert.equal(readFileSync(join(local, 'state', f), 'utf8'), readFileSync(join(remote, 'state', f), 'utf8'));
  assert.equal(readFileSync(join(local, 'state', collected[0]), 'utf8'), REPORT);
  for (const f of mine) assert.equal(readFileSync(join(local, 'state', f), 'utf8'), `local ${f}\n`);
  assert.equal(existsSync(join(local, 'state', 'logs/other.txt')), false);
  assert.equal(existsSync(join(local, 'state', 'ship-dag-wave.jsonl')), false);
});

test('rsyncArgs: goes over ssh with the shared options', () => {
  const args = rsyncArgs('box:/s/state/', '/l/state/');
  assert.equal(args[args.indexOf('-e') + 1], 'ssh -o BatchMode=yes -o ConnectTimeout=10');
  assert.deepEqual(args.slice(-2), ['box:/s/state/', '/l/state/']);
});
