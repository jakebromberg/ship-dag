// Tests for the per-repo test-suite config. Run: node --test "skills/ship-dag/eval/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REPO_TESTS, repoTestConfig } from './repo-tests.mjs';

const corpus = JSON.parse(readFileSync(new URL('./corpus.json', import.meta.url), 'utf8'));
const corpusRepos = [...new Set(corpus.entries.map((e) => e.repo))];

test('every corpus repo has a test config (the gate must know every repo)', () => {
  for (const repo of corpusRepos) {
    assert.ok(repoTestConfig(repo), `missing repo-tests entry for ${repo}`);
  }
});

test('every config entry is well-formed', () => {
  for (const [repo, cfg] of Object.entries(REPO_TESTS)) {
    assert.equal(typeof cfg.lang, 'string', `${repo}.lang`);
    assert.ok(Array.isArray(cfg.setup), `${repo}.setup is array`);
    assert.equal(typeof cfg.test, 'string', `${repo}.test`);
    assert.ok(cfg.timeoutSec > 0, `${repo}.timeoutSec positive`);
    assert.equal(typeof cfg.runsLocally, 'boolean', `${repo}.runsLocally`);
  }
});

test('repoTestConfig returns null for an unknown repo', () => {
  assert.equal(repoTestConfig('WXYC/does-not-exist'), null);
});
