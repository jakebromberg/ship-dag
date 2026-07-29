// Tests for complexity tiering. Run: node --test "skills/ship-dag/eval/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complexityTier } from './tier.mjs';

const cases = [
  ['tiny single-file → mechanical', { changedFiles: 1, additions: 5 }, 'mechanical'],
  ['empty → mechanical', {}, 'mechanical'],
  ['1 file but 11 adds → normal', { changedFiles: 1, additions: 11 }, 'normal'],
  ['3 files, 50 adds → normal', { changedFiles: 3, additions: 50 }, 'normal'],
  ['5 files → complex (file count)', { changedFiles: 5, additions: 10 }, 'complex'],
  ['200 adds → complex (size)', { changedFiles: 2, additions: 200 }, 'complex'],
  ['migration path beats small size → complex', { changedFiles: 1, additions: 5, files: ['db/migrate/001.sql'] }, 'complex'],
  ['security label → complex', { changedFiles: 2, additions: 30, labels: ['security'] }, 'complex'],
  ['label object form → complex', { changedFiles: 1, additions: 4, labels: [{ name: 'breaking-change' }] }, 'complex'],
  ['auth/ path → complex', { changedFiles: 1, additions: 3, files: ['src/auth/login.ts'] }, 'complex'],
  ['authors/ path does not over-match → mechanical', { changedFiles: 1, additions: 3, files: ['src/authors/list.ts'] }, 'mechanical'],
];

for (const [name, input, expected] of cases) {
  test(`complexityTier: ${name}`, () => {
    assert.equal(complexityTier(input), expected);
  });
}

test('complexityTier: null input does not throw', () => {
  assert.equal(complexityTier(null), 'mechanical');
});
