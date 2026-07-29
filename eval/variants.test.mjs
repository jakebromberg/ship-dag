// Tests for the variant vectors. Run: node --test "skills/ship-dag/eval/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VARIANTS, STAGES, resolveVariant } from './variants.mjs';

test('resolveVariant: current is the shipped H/S/O default', () => {
  const v = resolveVariant('current');
  assert.equal(v.triage.model, 'haiku');
  assert.equal(v.implement.model, 'sonnet');
  assert.equal(v.review.model, 'opus');
});

test('floor: Haiku triage kept, expensive review downgraded to Sonnet', () => {
  const v = resolveVariant('floor');
  assert.equal(v.triage.model, 'haiku');
  assert.equal(v.review.model, 'sonnet');
});

test('ceiling: every stage on opus', () => {
  const v = resolveVariant('ceiling');
  assert.ok(STAGES.every((s) => v[s].model === 'opus'));
});

test('resolveVariant: unknown throws with the valid set', () => {
  assert.throws(() => resolveVariant('nope'), /unknown variant: nope/);
});

test('every variant assigns model+effort to all three stages', () => {
  for (const [name, v] of Object.entries(VARIANTS)) {
    for (const stage of STAGES) {
      assert.equal(typeof v[stage]?.model, 'string', `${name}.${stage}.model`);
      assert.equal(typeof v[stage]?.effort, 'string', `${name}.${stage}.effort`);
    }
  }
});
