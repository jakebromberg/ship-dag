// Tests for the host-preflight pure core. Run: node --test "skills/ship-dag/eval/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requiredTools, resolveGatable } from './preflight-host.mjs';

test('requiredTools maps each language to its executables', () => {
  assert.deepEqual(requiredTools('python'), ['python3']);
  assert.deepEqual(requiredTools('ts'), ['node', 'npm']);
  assert.deepEqual(requiredTools('rust'), ['cargo']);
  assert.deepEqual(requiredTools('swift'), ['xcodebuild']);
  assert.deepEqual(requiredTools('cobol'), []);
});

test('intended-gatable repo with its toolchain present → gatable, not promoted/demoted', () => {
  const r = resolveGatable({ lang: 'python', runsLocally: true }, new Set(['python3', 'git']));
  assert.deepEqual(r, { gatable: true, promoted: false, demoted: false, required: ['python3'] });
});

test('intended-gatable repo missing a tool → demoted to parse-only', () => {
  const r = resolveGatable({ lang: 'ts', runsLocally: true }, new Set(['node'])); // npm missing
  assert.equal(r.gatable, false);
  assert.equal(r.demoted, true);
  assert.equal(r.promoted, false);
});

test('Swift is promoted to gatable when xcodebuild is present (detect, then decide)', () => {
  const r = resolveGatable({ lang: 'swift', runsLocally: false }, new Set(['xcodebuild']));
  assert.equal(r.gatable, true);
  assert.equal(r.promoted, true);
  assert.equal(r.demoted, false);
});

test('Swift stays parse-only when xcodebuild is absent (not demoted — it was never intended-gatable)', () => {
  const r = resolveGatable({ lang: 'swift', runsLocally: false }, new Set(['git']));
  assert.equal(r.gatable, false);
  assert.equal(r.promoted, false);
  assert.equal(r.demoted, false);
});
