// co-home.test.mjs — the one locator for the claude-orchestrator checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coHome, coDistPath, coDistPathIn, importCo } from './co-home.mjs';

// Derived, so the default path is written only in co-home.mjs.
const DEFAULT = coHome({});

test('coHome: CO_HOME wins; unset and empty fall back to the default checkout', () => {
  assert.equal(coHome({ CO_HOME: '/x' }), '/x');
  assert.equal(coHome({}), DEFAULT);
  assert.equal(coHome({ CO_HOME: '' }), DEFAULT);
});

test('coDistPath: joins segments under dist/src', () => {
  assert.equal(coDistPath({ CO_HOME: '/x' }), '/x/dist/src');
  assert.equal(coDistPath({ CO_HOME: '/x' }, 'cli-lease.js'), '/x/dist/src/cli-lease.js');
  assert.equal(coDistPath({}, 'index.js'), `${DEFAULT}/dist/src/index.js`);
});

test('coDistPathIn: joins onto an explicit home as-is, with no env fallback', () => {
  assert.equal(coDistPathIn('/x', 'cli-lease.js'), '/x/dist/src/cli-lease.js');
  assert.equal(coDistPathIn('', 'cli-lease.js'), 'dist/src/cli-lease.js');
  assert.throws(() => coDistPathIn(undefined, 'cli-lease.js'), TypeError);
});

test('importCo: returns the module, and names a missing export in the error', async () => {
  const home = mkdtempSync(join(tmpdir(), 'co-home-'));
  try {
    mkdirSync(join(home, 'dist', 'src'), { recursive: true });
    writeFileSync(join(home, 'dist', 'src', 'index.js'), 'export const a = () => 1; export const b = 2;');
    const env = { CO_HOME: home };
    assert.equal((await importCo(env, ['a'])).a(), 1);
    await assert.rejects(importCo(env, ['a', 'missing']), /index\.js does not export missing/);
    await assert.rejects(importCo(env, ['b']), /does not export b/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
