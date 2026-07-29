import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reposDirFromEnv } from './repos-dir.mjs';

// reposDirFromEnv resolves the org checkout root (the dir holding repo siblings)
// the worktree layer forks from — SHIP_DAG_REPOS_DIR first, else the projectRoot
// the skill already emits, else undefined so deriveWorktreeHooks keeps its own
// default (the WXYC no-regression path).

test('SHIP_DAG_REPOS_DIR wins when set', () => {
  assert.equal(
    reposDirFromEnv({ SHIP_DAG_REPOS_DIR: '/repos', SHIP_DAG_PROJECT_ROOT: '/proj' }),
    '/repos',
  );
});

test('falls back to SHIP_DAG_PROJECT_ROOT when SHIP_DAG_REPOS_DIR is unset', () => {
  assert.equal(reposDirFromEnv({ SHIP_DAG_PROJECT_ROOT: '/proj' }), '/proj');
});

test('an empty SHIP_DAG_REPOS_DIR does not override — falls through to project root', () => {
  assert.equal(
    reposDirFromEnv({ SHIP_DAG_REPOS_DIR: '', SHIP_DAG_PROJECT_ROOT: '/proj' }),
    '/proj',
  );
});

test('returns undefined when neither is set (engine applies its own default)', () => {
  assert.equal(reposDirFromEnv({}), undefined);
});
