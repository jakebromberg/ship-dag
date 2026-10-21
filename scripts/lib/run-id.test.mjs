// run-id.test.mjs — run-id minting, parsing, and run-family folding.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintRunId, canonicalRunId, runFamily, runIdFromConfigName, sameRun } from './run-id.mjs';

test('mintRunId: local-time stamp, with an optional slugged label', () => {
  const now = new Date(2026, 9, 8, 7, 5, 9);
  assert.equal(mintRunId({ now }), 'sd-20261008-070509');
  assert.equal(mintRunId({ now, label: '  Tuning R1: Run--IDs! ' }), 'sd-20261008-070509-tuning-r1-run-ids');
  assert.equal(mintRunId({ now, label: '!!!' }), 'sd-20261008-070509');
  assert.equal(mintRunId({ now, label: 'a'.repeat(60) }), `sd-20261008-070509-${'a'.repeat(40)}`);
});

test('runIdFromConfigName: strips one ship-dag- prefix; null for non-strings and empty', () => {
  assert.equal(runIdFromConfigName('ship-dag-sd-1'), 'sd-1');
  assert.equal(runIdFromConfigName('ship-dag-ship-dag-x'), 'ship-dag-x');
  assert.equal(runIdFromConfigName('hand-written'), 'hand-written');
  assert.equal(runIdFromConfigName(''), null);
  assert.equal(runIdFromConfigName(undefined), null);
  assert.equal(runIdFromConfigName(7), null);
});

test('canonicalRunId: folds prefix, case and wave suffixes; null for blank', () => {
  assert.equal(canonicalRunId('  Ship-Dag-SD-1-W2B '), 'sd-1');
  assert.equal(canonicalRunId('sd-1-wave3-resume'), 'sd-1');
  assert.equal(canonicalRunId('-w2'), '-w2');
  assert.equal(canonicalRunId('  '), null);
  assert.equal(canonicalRunId(null), null);
});

test('runFamily: canonicalRunId with a single-letter retry suffix folded too; null for blank', () => {
  assert.equal(runFamily('Ship-Dag-SD-1-W2-B'), 'sd-1');
  assert.equal(runFamily('sd-1-c-r2'), 'sd-1');
  assert.equal(runFamily('sd-1-board'), 'sd-1-board');
  assert.equal(runFamily(' '), null);
});

const BASE = 'sd-20261001-211607';
for (const [a, b, expected] of [
  [BASE, BASE, true],
  [`${BASE}-w2`, BASE, true],
  [`${BASE}-w4b`, BASE, true],
  [`${BASE}-w1aa`, BASE, true],
  [`${BASE}-w37aa`, BASE, true],
  [`${BASE}-w10`, BASE, true],
  [`${BASE}-b`, BASE, true],
  [`${BASE}-c`, BASE, true],
  [`${BASE}-r2`, BASE, true],
  [`${BASE}-resume`, BASE, true],
  [`${BASE}-w2-b`, BASE, true],
  [`ship-dag-${BASE}`, BASE, true],
  [BASE.toUpperCase(), BASE, true],
  [`${BASE}-w3`, `${BASE}-w9`, true],
  ['sd-20261001-211607-tuning-r1-w2', 'sd-20261001-211607-tuning-r1', true],
  [`${BASE}-board`, BASE, false],
  [`${BASE}-w2-board`, BASE, false],
  ['sd-X1', BASE, false],
  ['prqueue-20260831-w3', 'prqueue-20260831-w4', true],
  ['prqueue-20260831-w3', BASE, false],
  [BASE, null, false],
  [null, null, false],
  ['', '', false],
]) {
  test(`sameRun(${JSON.stringify(a)}, ${JSON.stringify(b)}) is ${expected}`, () => {
    assert.equal(sameRun(a, b), expected);
  });
}


test('canonicalRunId and runFamily are the plugin\'s single definitions, re-exported', async () => {
  const plugin = await import('../../plugins/ship-dag-eta/lib/run-id.mjs');
  assert.equal(canonicalRunId, plugin.canonicalRunId);
  assert.equal(runFamily, plugin.runFamily);
});

test('canonicalRunId and runFamily over the ETA parity ids', () => {
  const RUN = 'sd-20261017-080000';
  for (const [id, canon, family] of [
    [RUN, RUN, RUN], [`${RUN}-w1`, RUN, RUN], [`${RUN}-w1b`, RUN, RUN], [`${RUN}-w37aa`, RUN, RUN], [`${RUN}-b`, `${RUN}-b`, RUN], [`${RUN}-b-c`, `${RUN}-b-c`, `${RUN}-b`],
    [`${RUN}-r2`, RUN, RUN], [`${RUN}-resume`, RUN, RUN], [`${RUN}-wave3`, RUN, RUN], [`ship-dag-${RUN}-w2`, RUN, RUN],
    ['SD-20261017-080000-W2', RUN, RUN], [`${RUN.toUpperCase()}-B`, `${RUN}-b`, RUN], [`${RUN}-label`, `${RUN}-label`, `${RUN}-label`],
    [`${RUN}x`, `${RUN}x`, `${RUN}x`], ['', null, null], [null, null, null], [undefined, null, null], [7, null, null],
  ]) {
    assert.equal(canonicalRunId(id), canon, `canonicalRunId(${JSON.stringify(id)})`);
    assert.equal(runFamily(id), family, `runFamily(${JSON.stringify(id)})`);
  }
});
