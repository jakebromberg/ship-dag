// Tests for locating a run, its family dirs and its waves. Fixtures are real dirs built through the shared
// engine fixture; sidecars are written by waveSidecar from the config buildConfig makes, never by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRun, runWaves, readNotes, readBoard, readRetros } from './run.mjs';
import { RUN, engineFixture, stamped } from '../lib/engine-fixture.mjs';
import { waveSidecar } from '../lib/wave-sidecar.mjs';
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
    solo: {
      sidecar: [entry([1, 2], 7), entry([3], null), entry([9], 5)],
      configs: {
        'config-wave1.json': stamped(at(1), config([1, 2])), // fresh: sidecar says 7, over its filename
        'config-wave3.json': stamped(at(2), config([3])), // wave null: its filename says 3
        'config.json': stamped(at(3), config([4])), // no entry and no number: it sits in the run dir, so 1
      },
    },
  });
  assert.deepEqual(ids(runWaves({ runId: RUN, runDir: dirs.solo })), ['7', '3', '1']);
});

test('the base dir with no other source is 1', () => {
  const { dirs } = fixture({ [RUN]: { configs: { 'config.json': stamped(at(1), config([1])) } } });
  assert.deepEqual(ids(runWaves({ runId: RUN, runDir: dirs[RUN] })), ['1']);
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

test('retro records are the run family\'s, deduplicated, with engine and agent rows skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-run-'));
  fixtures.push({ cleanup: () => rmSync(dir, { recursive: true, force: true }) });
  const retro = (runId, extra = {}) => ({ kind: 'retro', runId, wave: 1, mergedPrs: [], ...extra });
  const rows = [retro(`ship-dag-${RUN}`), retro(`ship-dag-${RUN}`), retro(`${RUN}-b`, { wave: 2 }), retro('sd-other'), { kind: 'engine', runId: RUN }, { kind: 'agent', runId: RUN }, { kind: 'issue', runId: RUN }];
  const path = join(dir, 'runs.jsonl');
  writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  assert.deepEqual(readRetros(RUN, { path }).map((r) => r.wave), [1, 2]);
});
