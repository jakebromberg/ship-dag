// Tests for the host-run pure helpers. No test opens a connection; the collect test runs rsync between two local dirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { validateHosts } from './hosts.mjs';
import { engineCommand, outcome, parsePoll, pollDecision, pollScript, prefixLines, rsyncArgs } from './host-run.mjs';

const { box, big } = validateHosts({
  box: { ssh: 'box', home: '/h', reposDir: '/h/D', sdHome: '/h/D/ship-dag' },
  big: { ssh: 'big', home: '/b', reposDir: '/b/D', sdHome: '/b/D/ship-dag', coHome: '/b/co', sessionSlots: 3, leaseSlots: 5 },
});
const stateDir = '/h/.local/state/ship-dag/engine/run1';
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

for (const [name, kind, ctx, expected] of [
  ['a report was written', 'done', {}, { code: 0, message: undefined }],
  ['no report', 'no-report', { engineLog: 'box:/l/orchestrator.log' }, { code: 1, message: /exited with no report; see box:\/l\/orchestrator\.log/ }],
  ['a dropped connection (255)', 'dropped', { reattach: 'RE', collect: 'COLLECT' }, { code: 255, message: /connection dropped.*may still be running.*RE.*COLLECT/s }],
  ['a failed step', 'failed', { detail: 'rsync exited 23' }, { code: 1, message: /rsync exited 23/ }],
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
  ['a log chunk containing the marker', 'alive=0\nreports=1\n---\na\n---\nb\n', { alive: false, reports: 1, log: 'a\n---\nb\n' }],
]) {
  test(`parsePoll: ${name}`, () => {
    assert.deepEqual(parsePoll(out), expected);
  });
}

for (const [name, p, expected] of [
  ['the engine is alive', { alive: true, reports: 1 }, 'wait'],
  ['it exited with a report', { alive: false, reports: 1 }, 'done'],
  ['it exited without one', { alive: false, reports: 0 }, 'no-report'],
]) {
  test(`pollDecision: ${name}`, () => {
    assert.equal(pollDecision(p), expected);
  });
}

for (const [name, pid, offset, expected] of [
  ['a pid and an offset', 42, 10, /kill -0 42 .*reports'\/\*\.json.*tail -c \+11 '\/h\/\.local\/state\/ship-dag\/engine\/run1\/state\/logs\/orchestrator\.log'/s],
  ['no pid (--collect-only)', undefined, 0, /^echo alive=0; .*tail -c \+1 /s],
  ['a pid that is not a number', '4; rm -rf /', 0, /^echo alive=0; /],
]) {
  test(`pollScript: ${name}`, () => {
    assert.match(pollScript(stateDir, pid, offset), expected);
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
const put = (root, rel, body) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
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
