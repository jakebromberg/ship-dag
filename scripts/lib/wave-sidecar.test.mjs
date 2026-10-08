import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { waveSidecar, waveContextMatches, readSidecar, appendWave, findWaveContext, specBlockOn } from './wave-sidecar.mjs';
import { load as loadTuning } from './tuning.mjs';
import { DEFAULT_BLOCK_ON } from '../review-gate.mjs';

const REPO = 'WXYC/library-metadata-lookup';
const spec = (overrides = {}) => ({
  name: 'ship-dag-run1',
  repo: REPO,
  stateDir: '/state/run1',
  issues: [
    { number: 1, complexity: 'normal', model: 'sonnet', reach: 'repo', decisions: ['d1'] },
    { number: 2, repo: 'WXYC/other', complexity: 'complex', model: 'opus' },
  ],
  ...overrides,
});
const tmp = () => mkdtempSync(join(tmpdir(), 'sidecar-'));
const silent = () => {};
/** A dir no one can create, even as root: its parent is a regular file. */
const uncreatable = () => {
  const file = join(tmp(), 'a-file');
  writeFileSync(file, '');
  return join(file, 'run');
};

test('waveSidecar builds one entry', () => {
  const e = waveSidecar(spec({ wave: '14b', blockOn: 'contract-conformance, security' }), { now: () => 'T' });
  assert.equal(e.runId, 'run1');
  assert.equal(e.wave, '14b');
  assert.equal(e.tuningVersion, loadTuning().version);
  assert.deepEqual(e.blockOn, ['contract', 'security']);
  assert.equal(e.emittedAt, 'T');
  assert.deepEqual(e.issues, [
    { ref: `${REPO}#1`, complexity: 'normal', model: 'sonnet', reach: 'repo', decisions: ['d1'] },
    { ref: 'WXYC/other#2', complexity: 'complex', model: 'opus', reach: null, decisions: [] },
  ]);
});

test('waveSidecar defaults: spec.runId wins, wave null, default blockOn', () => {
  const e = waveSidecar(spec({ runId: 'explicit' }));
  assert.equal(e.runId, 'explicit');
  assert.equal(e.wave, null);
  assert.deepEqual(e.blockOn, DEFAULT_BLOCK_ON);
});

test('waveSidecar accepts blockOn as an array, normalized like the comma string', () => {
  for (const [blockOn, want] of [
    [['contract-conformance', ' Security'], ['contract', 'security']],
    ['contract-conformance, security', ['contract', 'security']],
    [[], DEFAULT_BLOCK_ON],
  ]) {
    assert.deepEqual(waveSidecar(spec({ blockOn })).blockOn, want, JSON.stringify(blockOn));
  }
});

test('specBlockOn refuses a non-string, non-array or unknown-category blockOn', () => {
  for (const [blockOn, msg] of [[1, /comma string or an array/], [{ a: 1 }, /comma string or an array/], ['corectness', /corectness/], [['bogus'], /bogus/]]) {
    assert.throws(() => specBlockOn(blockOn), msg, JSON.stringify(blockOn));
  }
});

test('waveSidecar stamps tuningVersion from the injected tuning object', () => {
  assert.equal(waveSidecar(spec(), { tuning: { version: 'v-injected' } }).tuningVersion, 'v-injected');
});

test('waveContextMatches compares the ref set, order-insensitive', () => {
  const e = waveSidecar(spec());
  assert.ok(waveContextMatches(e, [`WXYC/other#2`, `${REPO}#1`]));
  assert.ok(!waveContextMatches(e, [`${REPO}#1`]));
  assert.ok(!waveContextMatches(e, [`${REPO}#1`, 'WXYC/other#3']));
});

test('appendWave keeps both waves and findWaveContext picks the right one', () => {
  const dir = tmp();
  const w1 = waveSidecar(spec({ wave: 1, blockOn: 'security' }), { tuning: { version: 'v-wave1' } });
  const w2 = waveSidecar(spec({ wave: 2, issues: [{ number: 9, complexity: 'normal' }] }), { tuning: { version: 'v-wave2' } });
  appendWave(dir, w1);
  appendWave(dir, w2);
  assert.equal(readSidecar(join(dir, 'ship-dag-wave.json')).length, 2);
  const hit = findWaveContext(dir, [`${REPO}#1`, 'WXYC/other#2']);
  assert.equal(hit.wave, 1);
  assert.deepEqual(hit.blockOn, ['security']);
  assert.equal(hit.tuningVersion, 'v-wave1');
  assert.equal(findWaveContext(dir, ['nope#1']), null);
  assert.deepEqual(readdirSync(dir), ['ship-dag-wave.json'], 'no temp file left behind');
});

test('a corrupt or non-array sidecar is left untouched with a warning', () => {
  for (const content of ['{not json', '{"a":1}']) {
    const dir = tmp();
    const path = join(dir, 'ship-dag-wave.json');
    writeFileSync(path, content);
    const warnings = [];
    assert.equal(appendWave(dir, waveSidecar(spec()), { warn: (m) => warnings.push(m) }), false);
    assert.equal(readFileSync(path, 'utf-8'), content);
    assert.equal(warnings.length, 1);
  }
});

test('appendWave creates a state dir that does not exist yet', () => {
  const dir = join(tmp(), 'engine', 'run1');
  assert.equal(appendWave(dir, waveSidecar(spec())), true);
  assert.equal(readSidecar(join(dir, 'ship-dag-wave.json')).length, 1);
});

test('appendWave refuses a relative or missing dir instead of writing under the cwd', () => {
  for (const dir of ['undefined', 'rel/dir', undefined]) {
    const warnings = [];
    assert.equal(appendWave(dir, waveSidecar(spec()), { warn: (m) => warnings.push(m) }), false, String(dir));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /absolute/);
  }
  assert.ok(!existsSync('undefined') && !existsSync('rel'), 'nothing created under the cwd');
});

test('appendWave warns instead of throwing when the dir is unwritable', () => {
  const warnings = [];
  assert.equal(appendWave(uncreatable(), waveSidecar(spec()), { warn: (m) => warnings.push(m) }), false);
  assert.equal(warnings.length, 1);
});

test('the CLI writes the sidecar at dirname(configDir) and prints the same config either way', () => {
  const cli = fileURLToPath(new URL('../emit-config.mjs', import.meta.url));
  const run = (stateDir) => spawnSync(process.execPath, [cli, '-'], {
    input: JSON.stringify(spec({ stateDir, wave: 3, repos: { [REPO]: { commands: ['x'] }, 'WXYC/other': { commands: ['x'] } } })),
    encoding: 'utf-8',
  });
  const dir = tmp();
  const ok = run(dir);
  assert.equal(ok.status, 0);
  const entries = JSON.parse(readFileSync(join(dir, 'ship-dag-wave.json'), 'utf-8'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].wave, 3);
  // A stateDir whose sidecar cannot be written still prints a config (modulo the dir paths).
  const bad = uncreatable();
  const blocked = run(bad);
  assert.equal(blocked.status, 0);
  assert.match(blocked.stderr, /wave sidecar/);
  assert.equal(blocked.stdout.replaceAll(bad, dir), ok.stdout);
});

test('the CLI refuses an invalid blockOn with exit 2 before printing a config or writing the sidecar', () => {
  const cli = fileURLToPath(new URL('../emit-config.mjs', import.meta.url));
  const dir = tmp();
  const res = spawnSync(process.execPath, [cli, '-'], {
    input: JSON.stringify(spec({ stateDir: dir, blockOn: 'corectness', repos: { [REPO]: { commands: ['x'] }, 'WXYC/other': { commands: ['x'] } } })),
    encoding: 'utf-8',
  });
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /corectness/);
  assert.deepEqual(readdirSync(dir), [], 'no sidecar written');
});
