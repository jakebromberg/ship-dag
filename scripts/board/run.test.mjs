// Tests for locating a run, its family dirs and its waves. Fixtures are real dirs built through the shared
// engine fixture; sidecars are written by waveSidecar from the config buildConfig makes, never by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRun, runWaves, readNotes, readBoard, readRetros } from './run.mjs';
import { RUN, engineFixture, stamped } from '../lib/engine-fixture.mjs';
import { SIDECAR_NAME, waveSidecar } from '../lib/wave-sidecar.mjs';
import { appendRecord } from '../telemetry.mjs';
import { buildConfig } from '../emit-config.mjs';

const REPO = 'WXYC/dj-site';
const spec = (numbers, over = {}) => ({ name: `ship-dag-${RUN}`, repo: REPO, stateDir: '/state/run', issues: numbers.map((number) => ({ number, complexity: 'normal', model: 'sonnet' })), ...over });
const config = (numbers) => buildConfig(spec(numbers));
const entry = (numbers, wave) => { const s = spec(numbers, { wave }); return waveSidecar(s, { config: buildConfig(s) }); };
const at = (n) => `2026-10-08T1${n}:00:00.000Z`;
const ids = (waves) => waves.map((w) => w.id);

const fixtures = [];
const fixture = (specs) => { const fx = engineFixture(specs); fixtures.push(fx); return fx; };
test.after(() => fixtures.forEach((fx) => fx.cleanup()));

test('a family of sibling dirs is labelled by suffix, ordered by mtime, and leaves the -board dir out', () => {
  const { base, dirs } = fixture({
    [RUN]: { configs: { 'config.json': stamped(at(1), config([1])) } },
    [`${RUN}-w4b`]: { configs: { 'config.json': stamped(at(3), config([3])) } },
    [`${RUN}-w2`]: { configs: { 'config.json': stamped(at(2), config([2])) } },
    [`${RUN}-b`]: { configs: { 'config.json': stamped(at(4), config([4])) } },
    [`${RUN}-board`]: { configs: { 'config.json': stamped(at(5), config([9])) } },
  });
  const run = resolveRun({ runId: RUN, env: { XDG_STATE_HOME: base, HOME: '/nope' } });
  assert.equal(run.runDir, join(base, 'ship-dag/engine', RUN));
  const fam = resolveRun({ stateDir: dirs[RUN] });
  assert.deepEqual(fam, { runId: RUN, runDir: dirs[RUN] });
  const waves = runWaves(fam);
  assert.deepEqual(ids(waves), ['1', '2', '4b', '4b′']);
  assert.ok(waves.every((w) => !w.dir.endsWith('-board')));
});

test('one dir holding every wave: filename ids keep their letter, .bak and non-config JSON are not waves', () => {
  const { dirs } = fixture({
    solo: {
      configs: {
        'config-wave14b.json': stamped(at(3), config([14])),
        'config.wave2.json': stamped(at(1), config([2])),
        'config2.json': stamped(at(2), config([22])),
        'config.json.bak-1': stamped(at(4), config([5])),
      },
      files: { 'notes.json': { issues: [] }, 'config-empty.json': { name: 'x' } },
    },
  });
  const waves = runWaves({ runId: RUN, runDir: dirs.solo });
  assert.deepEqual(ids(waves), ['2', '2', '14b']);
});

test('a sidecar entry labels a wave only when its ref set matches; wave null and stale entries are absent', () => {
  const { dirs } = fixture({
    [RUN]: {
      sidecar: [entry([1, 2], 7), entry([3], null), entry([9], 5)],
      configs: {
        'config-wave1.json': stamped(at(1), config([1, 2])), // fresh: sidecar says 7, over its filename
        'config-wave3.json': stamped(at(2), config([3])), // wave null: its filename says 3
        'config.json': stamped(at(3), config([4])), // no entry and no number: it sits in the base dir, so 1
      },
    },
  });
  assert.deepEqual(ids(runWaves({ runId: RUN, runDir: dirs[RUN] })), ['7', '3', '1']);
});

test('the base dir with no other source is 1', () => {
  const { dirs } = fixture({ [RUN]: { configs: { 'config.json': stamped(at(1), config([1])) } } });
  assert.deepEqual(ids(runWaves({ runId: RUN, runDir: dirs[RUN] })), ['1']);
});

test('the older layout\'s state/config.json is a wave, and a config without a configDir string is not', () => {
  const { dirs } = fixture({
    [RUN]: { configs: { 'state/config.json': stamped(at(1), config([1])), 'config-wave2.json': stamped(at(2), { ...config([2]), configDir: undefined }) } },
  });
  const waves = runWaves({ runId: RUN, runDir: dirs[RUN] });
  assert.deepEqual(waves.map((w) => [w.id, w.configFile]), [['1', join(dirs[RUN], 'state', 'config.json')]]);
});

test('resolveRun({runId}) finds the run under $XDG_STATE_HOME/ship-dag/engine, and its waves through it', () => {
  const { base } = fixture({
    [`ship-dag/engine/${RUN}`]: { configs: { 'config.json': stamped(at(1), config([1])) } },
    [`ship-dag/engine/${RUN}-w2`]: { configs: { 'config.json': stamped(at(2), config([2])) } },
  });
  const run = resolveRun({ runId: RUN, env: { XDG_STATE_HOME: base, HOME: '/nope' } });
  assert.deepEqual(ids(runWaves(run)), ['1', '2']);
});

test('a ref set re-emitted under a new wave labels each config with its own entry, not the later one', () => {
  // Emit as emit-config does: write the config, then stamp and append its entry (emittedAt at millisecond
  // precision, so it can read earlier than its own config's fractional mtime).
  const { dirs } = fixture({ [RUN]: {} });
  const dir = dirs[RUN];
  const lines = [];
  for (const [name, wave] of [['config-a.json', '3'], ['config-b.json', '3b']]) {
    const since = Date.now();
    while (Date.now() < since + 2); // configs a real emit apart are at least a millisecond apart
    writeFileSync(join(dir, name), JSON.stringify(config([3])));
    lines.push(JSON.stringify(entry([3], wave)));
  }
  writeFileSync(join(dir, SIDECAR_NAME), lines.join('\n') + '\n');
  assert.deepEqual(ids(runWaves({ runId: RUN, runDir: dir })), ['3', '3b']);
});

// Each row: the family's dirs (name → configs, sidecar), the dir --state-dir names, and the ids expected oldest first.
const precedence = [
  ['the sidecar\'s wave beats a -w suffix', { [`${RUN}-w2`]: { sidecar: [entry([1], 5)], configs: { 'config.json': config([1]) } } }, `${RUN}-w2`, ['5']],
  ['a -w suffix beats the filename', { [`${RUN}-w3`]: { configs: { 'config-wave7.json': config([1]) } } }, `${RUN}-w3`, ['3']],
  ['a -w suffix keeps every letter', { [`${RUN}-w37aa`]: { configs: { 'config.json': config([1]) } } }, `${RUN}-w37aa`, ['37aa']],
  ['a filename id keeps every letter, in the base dir too', {
    [RUN]: { configs: { 'config-wave37aa.json': stamped(at(1), config([1])), 'config-wave38bs.json': stamped(at(2), config([2])) } },
  }, RUN, ['37aa', '38bs']],
  ['naming the -b dir leaves the base dir 1 and the retry 1′', {
    [RUN]: { configs: { 'config.json': stamped(at(1), config([1])) } },
    [`${RUN}-b`]: { configs: { 'config.json': stamped(at(2), config([2])) } },
  }, `${RUN}-b`, ['1', '1′']],
  ['the first wave outside the base dir with no other source is 1 (prev null)', { [`${RUN}-b`]: { configs: { 'config.json': config([1]) } } }, `${RUN}-b`, ['1']],
];
for (const [name, specs, named, want] of precedence) {
  test(`display id: ${name}`, () => {
    const { dirs } = fixture(specs);
    assert.deepEqual(ids(runWaves(resolveRun({ stateDir: dirs[named] }))), want);
  });
}

// The base dir is 1 however the run is spelled, even when its config is not the family's oldest.
for (const spelling of [RUN, `ship-dag-${RUN}`, `${RUN}-w2-b`, `${RUN}-r2`, RUN.toUpperCase()]) {
  test(`display id: the base dir is 1 when the run is named ${spelling}`, () => {
    const { dirs } = fixture({
      [`${RUN}-b`]: { configs: { 'config.json': stamped(at(1), config([1])) } },
      [RUN]: { configs: { 'config.json': stamped(at(2), config([2])) } },
    });
    assert.deepEqual(ids(runWaves({ runId: spelling, runDir: dirs[`${RUN}-b`] })), ['1', '1']);
  });
}

test('a torn sidecar line warns once per dir, however many configs the dir holds', () => {
  const lines = [entry([1], 1), entry([2], 2)].map((e) => JSON.stringify(e)).join('\n');
  const { dirs } = fixture({
    [RUN]: { files: { [SIDECAR_NAME]: `${lines}\n{torn\n` }, configs: { 'config-1.json': stamped(at(1), config([1])), 'config-2.json': stamped(at(2), config([2])) } },
  });
  const warnings = [];
  assert.deepEqual(ids(runWaves({ runId: RUN, runDir: dirs[RUN] }, { warn: (m) => warnings.push(m) })), ['1', '2']);
  assert.equal(warnings.length, 1);
});

test('resolveRun reads $SHIP_DAG_RUN_ID only when told to', () => {
  const env = { XDG_STATE_HOME: '/s', SHIP_DAG_RUN_ID: RUN };
  assert.throws(() => resolveRun({ env }), /--state-dir|--run-id/);
  assert.deepEqual(resolveRun({ env, envFallback: true }), { runId: RUN, runDir: join('/s/ship-dag/engine', RUN) });
});

test('board-notes.json and board.json read as null when missing, parsed when present, and throw naming the path when malformed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-run-'));
  fixtures.push({ cleanup: () => rmSync(dir, { recursive: true, force: true }) });
  assert.equal(readNotes(dir), null);
  assert.equal(readBoard(dir), null);
  writeFileSync(join(dir, 'board-notes.json'), '{"wave":"2"}');
  assert.deepEqual(readNotes(dir), { wave: '2' });
  writeFileSync(join(dir, 'board.json'), '{nope');
  assert.throws(() => readBoard(dir), (e) => e.message.includes(join(dir, 'board.json')));
  const other = join(dir, 'elsewhere.json');
  writeFileSync(other, '{"runId":"x"}');
  assert.deepEqual(readBoard(dir, { path: other }), { runId: 'x' });
});

const unreadable = [
  ['a directory', (path) => mkdirSync(path), false],
  ['a file it may not read', (path) => { writeFileSync(path, '{}'); chmodSync(path, 0o000); }, process.getuid?.() === 0], // root reads it anyway
];
for (const [name, make, skip] of unreadable) {
  test(`board.json that is ${name} throws a read error naming the path, not a JSON one`, { skip }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-run-'));
    fixtures.push({ cleanup: () => rmSync(dir, { recursive: true, force: true }) });
    const path = join(dir, 'board.json');
    make(path);
    assert.throws(() => readBoard(dir), (e) => e.message.includes(path) && /cannot read/.test(e.message) && !/not valid JSON/.test(e.message));
  });
}

test('retro records are the run family\'s, deduplicated, with engine and agent rows skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-run-'));
  fixtures.push({ cleanup: () => rmSync(dir, { recursive: true, force: true }) });
  const path = join(dir, 'runs.jsonl');
  writeFileSync(path, `${[{ kind: 'engine', runId: RUN }, { kind: 'agent', runId: RUN }, { kind: 'issue', runId: RUN }].map((r) => JSON.stringify(r)).join('\n')}\n`);
  let tick = 0;
  const now = () => `2026-10-08T19:00:0${tick++}.000Z`; // every append is stamped with its own ts, as telemetry does
  const retro = (runId, extra = {}) => appendRecord({ kind: 'retro', runId, wave: 1, mergedPrs: [], ...extra }, { path, now });
  [retro(`ship-dag-${RUN}`), retro(`ship-dag-${RUN}`), retro(`${RUN}-b`, { wave: 2 }), retro('sd-other')];
  assert.deepEqual(readRetros(RUN, { path }).map((r) => r.wave), [1, 2]);
});
