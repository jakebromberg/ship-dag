// Tests for the host-prepare CLI core against a fake runner: no test opens a connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareHost } from './host-prepare.mjs';

const dir = mkdtempSync(join(tmpdir(), 'host-prepare-'));
const configPath = join(dir, 'config.box.json');
const body = JSON.stringify({ stateDir: '/h/s', repos: { 'o/app': {}, 'o/lib': {} } });
writeFileSync(configPath, body);
const configHash = createHash('sha256').update(body).digest('hex');
const hosts = { box: { ssh: 'box', home: '/h', reposDir: '/h/D', sdHome: '/h/D/ship-dag' } };
const local = { sdSha: 'a', coSha: 'b', claudeHash: 'c' };
const state = (over = {}) => ({ sdSha: 'a', coSha: 'b', coCommitTime: 1, distMtime: 2, claudeHash: 'c', configHash: '', freeKb: 99 * 1048576, present: ['app'], ...over });
const probeOut = (s) => [...Object.entries(s).filter(([k]) => k !== 'present').map(([k, v]) => `${k}=${v}`), ...s.present.map((n) => `present=${n}`)].join('\n');

function exec(s, opts = {}) {
  const calls = [];
  const run = { ssh: (alias, cmd) => (calls.push(['ssh', alias, cmd]), calls.length === 1 ? probeOut(s) : ''), scp: (alias, from, to) => calls.push(['scp', alias, from, to]) };
  const logs = [];
  const code = prepareHost({ name: 'box', hosts, config: JSON.parse(body), configPath, local, run, minFreeGb: 10, dryRun: false, log: (m) => logs.push(m), ...opts });
  return { code, calls, logs };
}

test('clones only the absent repo, fetches both, makes the state dir and copies the config', () => {
  const { code, calls } = exec(state());
  assert.equal(code, 0);
  assert.deepEqual(calls.slice(1).map((c) => c[2]), ["git -C '/h/D/app' fetch origin", "gh repo clone 'o/lib' '/h/D/lib'", "git -C '/h/D/lib' fetch origin", "mkdir -p '/h/s'", configPath]);
  assert.deepEqual(calls.at(-1), ['scp', 'box', configPath, '/h/s/config.json']);
});

test('a second run with the repos present and the config in place clones and copies nothing', () => {
  const { code, calls } = exec(state({ present: ['app', 'lib'], configHash }));
  assert.equal(code, 0);
  assert.deepEqual(calls.slice(1).map((c) => c[0]), ['ssh', 'ssh', 'ssh']);
  assert.ok(!calls.some((c) => /clone|scp/.test(c[2] ?? '') || c[0] === 'scp'));
});

test('--dry-run runs only the probe and logs the plan', () => {
  const { code, calls, logs } = exec(state(), { dryRun: true });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.ok(logs.some((l) => l.startsWith('would run: clone o/lib')));
});

test('a refusal exits 1 after the probe and runs nothing', () => {
  const { code, calls, logs } = exec(state({ sdSha: 'z' }));
  assert.equal(code, 1);
  assert.equal(calls.length, 1);
  assert.match(logs.join('\n'), /box: ship-dag is at z/);
});

test('a failing call names the host and step', () => {
  const run = { ssh: () => { throw new Error('timed out'); }, scp: () => {} };
  assert.throws(() => prepareHost({ name: 'box', hosts, config: JSON.parse(body), configPath, local, run, minFreeGb: 10, log() {} }), /host-prepare: box: probe failed: timed out/);
});

test('an unknown host throws, naming the known ones', () => {
  assert.throws(() => prepareHost({ name: 'nope', hosts, config: {}, configPath, local, run: {}, log() {} }), /unknown host "nope"; known: box/);
});
