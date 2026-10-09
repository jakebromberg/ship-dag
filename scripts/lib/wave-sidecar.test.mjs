import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { waveSidecar as wave_, waveContextMatches, readSidecar, appendWave, findWaveContext, specBlockOn, SIDECAR_NAME } from './wave-sidecar.mjs';
import { load as loadTuning } from './tuning.mjs';
import { buildConfig } from '../emit-config.mjs';
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
/** waveSidecar over the config buildConfig makes from `s`, as emit-config's CLI does. */
const wave = (s, opts = {}) => wave_(s, { config: buildConfig(s), ...opts });
const tuning = loadTuning();
const tmp = () => mkdtempSync(join(tmpdir(), 'sidecar-'));
const silent = () => {};
/** A dir no one can create, even as root: its parent is a regular file. */
const uncreatable = () => {
  const file = join(tmp(), 'a-file');
  writeFileSync(file, '');
  return join(file, 'run');
};

test('waveSidecar builds one entry', () => {
  const e = wave(spec({ wave: '14b', blockOn: 'contract-conformance, security' }), { now: () => 'T' });
  assert.equal(e.runId, 'run1');
  assert.equal(e.wave, '14b');
  assert.equal(e.tuningVersion, loadTuning().version);
  assert.deepEqual(e.blockOn, ['contract', 'security']);
  assert.equal(e.emittedAt, 'T');
  assert.deepEqual(e.issues, [
    { ref: `${REPO}#1`, complexity: 'normal', effort: tuning.implement.normal, effortSource: 'tuning', model: 'sonnet', reach: 'repo', decisions: ['d1'] },
    { ref: 'WXYC/other#2', complexity: 'complex', effort: tuning.implement.complex, effortSource: 'tuning', model: 'opus', reach: null, decisions: [] },
  ]);
});

test('waveSidecar records the effort, its source, and the model the config resolved', () => {
  for (const [name, issue, want] of [
    ['own effort overrides the tuning map', { complexity: 'complex', effort: 'low' }, { effort: 'low', effortSource: 'override' }],
    ['complexity maps through tuning', { complexity: 'complex' }, { effort: tuning.implement.complex, effortSource: 'tuning' }],
    ['no complexity takes the default', {}, { effort: tuning.implement.normal, effortSource: 'default' }],
    ['no model takes defaultModel', { model: undefined }, { model: 'haiku' }],
    ['own model wins over defaultModel', { model: 'opus' }, { model: 'opus' }],
  ]) {
    const [entry] = wave(spec({ defaultModel: 'haiku', issues: [{ number: 5, ...issue }] })).issues;
    assert.deepEqual({ ...entry }, { ...entry, ...want }, name);
  }
});

test('waveSidecar defaults: spec.runId wins, wave null, default blockOn', () => {
  const e = wave(spec({ runId: 'explicit' }));
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
    assert.deepEqual(wave(spec({ blockOn })).blockOn, want, JSON.stringify(blockOn));
  }
});

test('specBlockOn refuses a non-string, non-array or unknown-category blockOn', () => {
  for (const [blockOn, msg] of [[1, /comma string or an array/], [{ a: 1 }, /comma string or an array/], ['corectness', /corectness/], [['bogus'], /bogus/]]) {
    assert.throws(() => specBlockOn(blockOn), msg, JSON.stringify(blockOn));
  }
});

test('waveSidecar stamps tuningVersion from the injected tuning object', () => {
  assert.equal(wave(spec(), { tuning: { version: 'v-injected' } }).tuningVersion, 'v-injected');
});

test('waveContextMatches compares the ref set, order-insensitive', () => {
  const e = wave(spec());
  assert.ok(waveContextMatches(e, [`WXYC/other#2`, `${REPO}#1`]));
  assert.ok(!waveContextMatches(e, [`${REPO}#1`]));
  assert.ok(!waveContextMatches(e, [`${REPO}#1`, 'WXYC/other#3']));
});

test('appendWave keeps both waves and findWaveContext picks the right one', () => {
  const dir = tmp();
  const w1 = wave(spec({ wave: 1, blockOn: 'security' }), { tuning: { version: 'v-wave1' } });
  const w2 = wave(spec({ wave: 2, issues: [{ number: 9, complexity: 'normal' }] }), { tuning: { version: 'v-wave2' } });
  appendWave(dir, w1);
  appendWave(dir, w2);
  assert.equal(readSidecar(join(dir, SIDECAR_NAME)).length, 2);
  const hit = findWaveContext(dir, [`${REPO}#1`, 'WXYC/other#2']);
  assert.equal(hit.wave, 1);
  assert.deepEqual(hit.blockOn, ['security']);
  assert.equal(hit.tuningVersion, 'v-wave1');
  assert.equal(findWaveContext(dir, ['nope#1']), null);
  assert.deepEqual(readdirSync(dir), [SIDECAR_NAME], 'only the sidecar is written');
});

test('the sidecar is JSONL: one entry per line, appended without rewriting what is there', () => {
  assert.equal(SIDECAR_NAME, 'ship-dag-wave.jsonl');
  const dir = tmp();
  appendWave(dir, wave(spec({ wave: 1 })));
  const path = join(dir, SIDECAR_NAME);
  const first = readFileSync(path, 'utf-8');
  appendWave(dir, wave(spec({ wave: 2 })));
  const after = readFileSync(path, 'utf-8');
  assert.ok(after.startsWith(first), 'the first wave\'s bytes are untouched');
  assert.deepEqual(after.trimEnd().split('\n').map((l) => JSON.parse(l).wave), [1, 2]);
});

test('a corrupt line costs only itself: later waves still record and read back, with a warning', () => {
  const dir = tmp();
  const path = join(dir, SIDECAR_NAME);
  appendWave(dir, wave(spec({ wave: 1 })));
  writeFileSync(path, readFileSync(path, 'utf-8') + '{not json\n[1,2]\n');
  assert.equal(appendWave(dir, wave(spec({ wave: 2 }))), true);
  const warnings = [];
  assert.deepEqual(readSidecar(path, { warn: (m) => warnings.push(m) }).map((e) => e.wave), [1, 2]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /2 unreadable line/);
});

test('a torn last line (no trailing newline) costs only itself: the next wave still records', () => {
  const dir = tmp();
  const path = join(dir, SIDECAR_NAME);
  appendWave(dir, wave(spec({ wave: 1 })));
  writeFileSync(path, readFileSync(path, 'utf-8') + '{"wave": 2, "torn');
  assert.equal(appendWave(dir, wave(spec({ wave: 3 }))), true);
  assert.deepEqual(readSidecar(path, { warn: () => {} }).map((e) => e.wave), [1, 3]);
});

test('appendWave creates a state dir that does not exist yet', () => {
  const dir = join(tmp(), 'engine', 'run1');
  assert.equal(appendWave(dir, wave(spec())), true);
  assert.equal(readSidecar(join(dir, SIDECAR_NAME)).length, 1);
});

test('appendWave refuses a relative or missing dir instead of writing under the cwd', () => {
  for (const dir of ['undefined', 'rel/dir', undefined]) {
    const warnings = [];
    assert.equal(appendWave(dir, wave(spec()), { warn: (m) => warnings.push(m) }), false, String(dir));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /absolute/);
  }
  assert.ok(!existsSync('undefined') && !existsSync('rel'), 'nothing created under the cwd');
});

test('appendWave warns instead of throwing when the dir is unwritable', () => {
  const warnings = [];
  assert.equal(appendWave(uncreatable(), wave(spec()), { warn: (m) => warnings.push(m) }), false);
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
  const entries = readSidecar(join(dir, SIDECAR_NAME));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].wave, 3);
  // A stateDir whose sidecar cannot be written still prints a config (modulo the dir paths).
  const bad = uncreatable();
  const blocked = run(bad);
  assert.equal(blocked.status, 0);
  assert.match(blocked.stderr, /wave sidecar/);
  assert.equal(blocked.stdout.replaceAll(bad, dir), ok.stdout);
});
