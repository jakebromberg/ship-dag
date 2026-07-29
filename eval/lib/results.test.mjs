// Tests for results.mjs. Run: node --test "skills/ship-dag/eval/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultsDir, writeResults, readResults, listResults } from './results.mjs';

// In-memory fs double — deterministic, no temp-dir cleanup.
function memFs() {
  const files = new Map();
  const dirs = new Set();
  return {
    files,
    existsSync: (p) => files.has(p) || dirs.has(p),
    mkdirSync: (p) => { dirs.add(p); },
    writeFileSync: (p, c) => { files.set(p, c); },
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p);
    },
    readdirSync: (p) => [...files.keys()].filter((f) => f.startsWith(`${p}/`)).map((f) => f.slice(p.length + 1)),
  };
}

test('resultsDir: env resolution order', () => {
  assert.equal(resultsDir({ SHIP_DAG_EVAL_RESULTS: '/x' }), '/x');
  assert.equal(resultsDir({ XDG_STATE_HOME: '/s' }), '/s/ship-dag/eval-results');
  assert.equal(resultsDir({ HOME: '/home/j' }), '/home/j/.local/state/ship-dag/eval-results');
});

test('writeResults: writes <runId>.json and round-trips', () => {
  const fs = memFs();
  const path = writeResults({ runId: 'run-1', variant: 'current' }, { dir: '/d', fs });
  assert.equal(path, '/d/run-1.json');
  assert.deepEqual(readResults('run-1', { dir: '/d', fs }), { runId: 'run-1', variant: 'current' });
});

test('writeResults: refuses to overwrite an existing runId', () => {
  const fs = memFs();
  writeResults({ runId: 'run-1' }, { dir: '/d', fs });
  assert.throws(() => writeResults({ runId: 'run-1' }, { dir: '/d', fs }), /never overwritten/);
});

test('writeResults: requires a runId', () => {
  assert.throws(() => writeResults({ variant: 'x' }, { dir: '/d', fs: memFs() }), /runId is required/);
});

test('listResults: maps filenames to runIds, sorted; missing dir → []', () => {
  const fs = memFs();
  assert.deepEqual(listResults({ dir: '/d', fs }), []);
  writeResults({ runId: 'b' }, { dir: '/d', fs });
  writeResults({ runId: 'a' }, { dir: '/d', fs });
  assert.deepEqual(listResults({ dir: '/d', fs }), ['a', 'b']);
});
