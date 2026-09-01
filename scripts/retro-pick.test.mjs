// Tests for point D's one-proposal-at-a-time reader.
// Run: node --test "skills/ship-dag/scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposals, pick } from './retro-pick.mjs';

const retro = {
  mergedPrs: ['o/r#41', 'o/r#43'],
  refactors: [
    { id: 'R1', title: 'Extract shared backoff helper', repo: 'o/r', body: 'long drafted ticket body' },
    { id: 'R2', title: 'Unify fixture setup', repo: 'o/r', body: 'another long body' },
  ],
  planAdjustments: [{ id: 'P1', ref: 'o/r#55', kind: 'respec', proposal: 'replacement spec text' }],
  observations: ['nothing else worth a ticket'],
};

test('proposals: refactors then adjustments, each tagged with its list', () => {
  assert.deepEqual(proposals(retro).map((p) => [p.id, p.list]), [
    ['R1', 'refactor'],
    ['R2', 'refactor'],
    ['P1', 'planAdjustment'],
  ]);
});

test('proposals: a pass that proposed nothing is empty, not an error', () => {
  assert.deepEqual(proposals({ observations: ['all clear'] }), []);
  assert.deepEqual(proposals(null), []);
});

test('pick: returns the whole proposal, drafted body included', () => {
  assert.equal(pick(retro, 'R1').body, 'long drafted ticket body');
  assert.equal(pick(retro, 'R1').list, 'refactor');
});

test('pick: a plan adjustment keeps its own kind rather than being overwritten by the list tag', () => {
  // planAdjustments carry their own `kind` (respec | add-edge | ...); the list
  // tag must not clobber it, or point D would file a respec as a refactor.
  assert.equal(pick(retro, 'P1').kind, 'respec');
  assert.equal(pick(retro, 'P1').list, 'planAdjustment');
  assert.equal(pick(retro, 'P1').proposal, 'replacement spec text');
});

test('pick: an unknown id throws and lists the ids that do exist', () => {
  assert.throws(() => pick(retro, 'R9'), /R1, R2, P1/);
});

test('pick: an empty pass says so rather than listing nothing', () => {
  assert.throws(() => pick({ observations: [] }, 'R1'), /proposed nothing/);
});
