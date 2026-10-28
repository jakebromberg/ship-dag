import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { waveSidecar as wave_, waveContextMatches, readSidecar, appendWave, findWaveContext, findWaveConfig, waveConfigs, entryFromConfig, specBlockOn, newestEntries, SIDECAR_NAME } from './wave-sidecar.mjs';
import { parseRef } from './ref.mjs';
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

test('waveSidecar records the host only when given one', () => {
  assert.equal(wave(spec()).host, undefined);
  assert.equal('host' in wave(spec()), false);
  assert.equal(wave(spec(), { host: 'box' }).host, 'box');
  assert.deepEqual(Object.keys(wave(spec(), { host: 'box' })).slice(0, 2), ['runId', 'host']);
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

test('the same issue number in two repos keeps each issue its own ref, effort and context', () => {
  const s = spec({
    issues: [{ number: 5, repo: REPO, complexity: 'mechanical' }, { number: 5, repo: 'WXYC/other', complexity: 'complex' }],
    repos: { [REPO]: { commands: ['x'] }, 'WXYC/other': { commands: ['x'] } },
  });
  const tuning = loadTuning();
  const e = wave(s);
  assert.deepEqual(e.issues.map((i) => [i.ref, i.effort]), [[`${REPO}#5`, tuning.implement.mechanical], ['WXYC/other#5', tuning.implement.complex]]);
  assert.ok(waveContextMatches(e, [`${REPO}#5`, 'WXYC/other#5']));
});

test('waveSidecar names the missing config instead of failing with a TypeError', () => {
  assert.throws(() => wave_(spec()), /needs the config buildConfig returned/);
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

// A re-emit of one ref set (a retry with escalated routing) is not the routing an earlier report ran under.
for (const [asOf, want] of [[undefined, 2], ['2026-10-08T19:00:00.000Z', 1], ['2026-10-08T17:00:00.000Z', null]]) {
  test(`findWaveContext takes the latest matching entry emitted at or before ${asOf ?? 'any time'}`, () => {
    const dir = tmp();
    try {
      appendWave(dir, wave(spec({ wave: 1 }), { now: () => '2026-10-08T18:00:00.000Z' }));
      appendWave(dir, wave(spec({ wave: 2 }), { now: () => '2026-10-08T20:00:00.000Z' }));
      assert.equal(findWaveContext(dir, [`${REPO}#1`, 'WXYC/other#2'], { asOf: asOf && Date.parse(asOf) })?.wave ?? null, want);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('findWaveContext reports a torn sidecar line through the warn it is handed', () => {
  const dir = tmp();
  try {
    appendWave(dir, wave(spec({ wave: 1 })));
    appendFileSync(join(dir, SIDECAR_NAME), '{torn\n');
    const warnings = [];
    assert.equal(findWaveContext(dir, [`${REPO}#1`, 'WXYC/other#2'], { warn: (m) => warnings.push(m) }).wave, 1);
    assert.match(warnings.join('\n'), /skipped 1 unreadable line/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

const cfg = (refs, over = {}) => JSON.stringify({ name: 'ship-dag-run1', issues: refs.map((r) => parseRef(r)), ...over });

test('findWaveConfig picks the config whose issue refs equal the set, skipping unreadable files', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'config-a.json'), cfg(['a/b#1']));
    writeFileSync(join(dir, 'config-b.json'), cfg(['a/b#1', 'c/d#2']));
    writeFileSync(join(dir, 'config-torn.json'), '{');
    writeFileSync(join(dir, 'notes.json'), cfg(['a/b#1', 'c/d#3']));
    writeFileSync(join(dir, 'config-no-issues.json'), JSON.stringify({ name: 'ship-dag-run1' }));
    assert.equal(findWaveConfig(dir, ['c/d#2', 'a/b#1']).issues.length, 2);
    assert.equal(findWaveConfig(dir, ['a/b#1']).issues.length, 1);
    assert.equal(findWaveConfig(dir, ['c/d#3', 'a/b#1']), null, 'only config*.json files are candidates');
    assert.equal(findWaveConfig(dir, []), null, 'a config without an issues array matches no ref set, not the empty one');
    assert.equal(findWaveConfig(join(dir, 'missing'), ['a/b#1']), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Two configs for one ref set (a re-emitted wave): the newer file wins, whatever the names sort as,
// unless it was written after `asOf` (ms), the report's start.
for (const [newer, asOf, want] of [
  ['config-wave1b.json', undefined, 'opus'],
  ['config.json', undefined, 'sonnet'],
  ['config-wave1b.json', 1_500_000_000_000, 'sonnet'],
  ['config-wave1b.json', 500_000_000_000, null],
]) {
  test(`findWaveConfig takes the newest of two configs sharing a ref set by mtime (${newer} newer, as of ${asOf ?? 'any time'})`, () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'config.json'), cfg(['a/b#1'], { defaultModel: 'sonnet' }));
      writeFileSync(join(dir, 'config-wave1b.json'), cfg(['a/b#1'], { defaultModel: 'opus' }));
      for (const name of ['config.json', 'config-wave1b.json']) {
        const at = name === newer ? 2_000_000_000 : 1_000_000_000;
        utimesSync(join(dir, name), at, at);
      }
      assert.equal(findWaveConfig(dir, ['a/b#1'], { asOf })?.defaultModel ?? null, want);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('entryFromConfig routes each config issue as waveSidecar does, and carries no blockOn or tuningVersion', () => {
  const s = spec({ defaultModel: 'haiku', issues: [{ number: 1, complexity: 'complex', model: 'opus' }, { number: 2, repo: 'WXYC/other', effort: 'low' }, { number: 3 }] });
  const config = buildConfig(s);
  const entry = entryFromConfig(config);
  const routing = ({ ref, effort, model }) => ({ ref, effort, model });
  assert.equal(entry.runId, 'run1');
  assert.deepEqual(entry.issues.map(routing), wave(s).issues.map(routing));
  assert.deepEqual(entry.issues.map((i) => i.complexity), ['complex', undefined, undefined]);
  assert.deepEqual([entry.blockOn, entry.tuningVersion], [undefined, undefined]);
});

test('findWaveConfig names the path of the file it read as configFile, and waveConfigs lists every readable config by path', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'config-2.json'), cfg(['a/b#1']));
    writeFileSync(join(dir, 'config-torn.json'), '{');
    writeFileSync(join(dir, 'config-no-issues.json'), JSON.stringify({ name: 'x' }));
    assert.equal(findWaveConfig(dir, ['a/b#1']).configFile, join(dir, 'config-2.json'));
    assert.deepEqual(waveConfigs(dir).map((c) => c.configFile), [join(dir, 'config-2.json')]);
    assert.deepEqual(waveConfigs(join(dir, 'missing')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- newestEntries: each ref's newest sidecar entry across an engine base dir (issue #522) ----

/** A base dir holding one run dir per key of `runs`, each with a sidecar of the given entries (a string is written as a raw line). */
function baseWith(runs) {
  const base = mkdtempSync(join(tmpdir(), 'newest-entries-'));
  for (const [run, lines] of Object.entries(runs)) {
    const dir = join(base, run);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SIDECAR_NAME), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  }
  return base;
}
const entry = (runId, emittedAt, refs) => ({ runId, emittedAt, issues: refs.map((ref) => ({ ref })) });

test('newestEntries keeps each ref\'s newest entry by emittedAt across run dirs, keyed case-insensitively', () => {
  const base = baseWith({
    'sd-a': [entry('sd-a', '2026-10-01T00:00:00Z', ['O/r#1', 'o/r#2']), entry('sd-a', '2026-10-03T00:00:00Z', ['o/r#2'])],
    'sd-b': [entry('sd-b', '2026-10-02T00:00:00Z', ['o/r#1', 'o/r#2'])],
  });
  try {
    const got = newestEntries(base, { warn: () => {} });
    assert.equal(got.get('o/r#1').entry.runId, 'sd-b');
    assert.equal(got.get('o/r#1').ref, 'o/r#1');
    assert.equal(got.get('o/r#1').dir, join(base, 'sd-b'));
    assert.equal(got.get('o/r#2').entry.runId, 'sd-a');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('newestEntries: on an equal emittedAt the later-listed entry wins, and an unparseable emittedAt counts as the epoch', () => {
  const base = baseWith({ 'sd-a': [entry('sd-a', '2026-10-01T00:00:00Z', ['o/r#1']), entry('sd-a2', '2026-10-01T00:00:00Z', ['o/r#1']), entry('sd-a', 'nope', ['o/r#3']), entry('sd-a3', null, ['o/r#3'])] });
  try {
    const got = newestEntries(base, { warn: () => {} });
    assert.equal(got.get('o/r#1').entry.runId, 'sd-a2');
    assert.equal(got.get('o/r#3').entry.runId, 'sd-a3', 'both read as 0, so the later wins');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('newestEntries leaves out what skip rejects, warns once per unreadable sidecar, and reads a missing base as empty', () => {
  const base = baseWith({ 'sd-a': [entry('sd-a', '2026-10-05T00:00:00Z', ['o/r#1'])], 'sd-b': [entry('sd-b', '2026-10-01T00:00:00Z', ['o/r#1']), '{torn'] });
  try {
    const warns = [];
    const got = newestEntries(base, { warn: (m) => warns.push(m), skip: (dir, e) => e.runId === 'sd-a' });
    assert.equal(got.get('o/r#1').entry.runId, 'sd-b');
    assert.equal(warns.length, 1);
    assert.match(warns[0], /skipped 1 unreadable line/);
    assert.equal(newestEntries(join(base, 'absent'), { warn: () => {} }).size, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('newestEntries breaks a tie across run dirs by dir name, the later name winning, whatever order the file system lists them in', () => {
  const at = '2026-10-01T00:00:00Z';
  const base = baseWith({ 'sd-b': [entry('sd-b', at, ['o/r#1'])], 'sd-a': [entry('sd-a', at, ['o/r#1'])], 'sd-c': [entry('sd-c', 'nope', ['o/r#1'])] });
  try {
    assert.equal(newestEntries(base, { warn: () => {} }).get('o/r#1').entry.runId, 'sd-b');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('newestEntries hands skip the run dir\'s full path, and skips an entry whose issues are not an array or hold no ref, without throwing', () => {
  const base = baseWith({ 'sd-a': [entry('sd-a', '2026-10-02T00:00:00Z', ['o/r#1'])], 'sd-b': [entry('sd-b', '2026-10-01T00:00:00Z', ['o/r#1']), { runId: 'sd-b', issues: { ref: 'o/r#2' } }, { runId: 'sd-b', issues: [null, 7, {}, { ref: 'o/r#3' }] }] });
  try {
    const seen = [];
    const got = newestEntries(base, { warn: () => {}, skip: (dir) => { seen.push(dir); return dir === join(base, 'sd-a'); } });
    assert.ok(seen.includes(join(base, 'sd-a')) && seen.includes(join(base, 'sd-b')), JSON.stringify(seen));
    assert.equal(got.get('o/r#1').entry.runId, 'sd-b');
    assert.deepEqual([...got.keys()].sort(), ['o/r#1', 'o/r#3']);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
