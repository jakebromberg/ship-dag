// Tests for the mutant-bank builder. Run: node --test "skills/ship-dag/eval/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSourceFile, bankEntry, summarize, buildBank, ALL_KINDS } from './build-mutant-bank.mjs';
import { GATED, PARSE_ONLY } from './lib/gate.mjs';

test('isSourceFile keeps code, drops lockfiles/docs/data/vendored', () => {
  // .sql is a corpus language (PLpgSQL) — kept as (parse-only) source, not dropped.
  for (const p of ['src/app.ts', 'lib/query.py', 'engine/mod.rs', 'App/View.swift', 'db/functions/match.sql']) {
    assert.ok(isSourceFile(p), `should keep ${p}`);
  }
  for (const p of ['package-lock.json', 'Cargo.lock', 'README.md', 'data/fixtures.json', 'node_modules/x/index.js', 'dist/bundle.min.js', 'logo.png']) {
    assert.ok(!isSourceFile(p), `should drop ${p}`);
  }
});

test('bankEntry carries a deterministic re-apply descriptor (index/before/after) + tier', () => {
  const entry = { repo: 'WXYC/x', issue: 7, pr: 9, tier: 'normal', mergeSha: 'abc123' };
  const mutant = { kind: 'relational', ordinal: 0, line: 12, index: 40, before: '<', after: '<=' };
  const gate = { testStatus: 'gated-failed', bucket: GATED, valid: true };
  const e = bankEntry(entry, 'src/a.ts', mutant, gate);
  assert.equal(e.mergeSha, 'abc123');
  assert.equal(e.tier, 'normal');
  assert.equal(e.file, 'src/a.ts');
  assert.equal(e.index, 40);
  assert.equal(e.before, '<');
  assert.equal(e.after, '<=');
  assert.equal(e.testStatus, 'gated-failed');
  assert.equal(e.bucket, GATED);
  assert.match(e.defect, /relational/); // synthesized when none supplied
});

// A fake env: the file has one relational site (` < `); the "suite" fails for
// that mutation on repo A (gatable) and repo B is parse-only.
function fakeEnv({ runsLocally, baselineGreen = true }) {
  return {
    prepare: async () => ({ ok: true, dir: '/fake', runsLocally, baseline: runsLocally ? { ran: true, passed: baselineGreen } : null }),
    sourceFiles: async () => ['src/a.ts', 'package-lock.json'], // the lockfile must be filtered out
    readSource: () => 'if (a < b) return 1;\n',
    testMutant: async () => (runsLocally
      ? { mutated: { ran: true, passed: false }, parses: true, diff: '@@ -1 +1 @@\n-if (a < b) return 1;\n+if (a <= b) return 1;\n' }
      : { mutated: null, parses: true, diff: '@@ diff @@' }),
    cleanup: () => {},
  };
}

test('buildBank gates a real defect into the GATED bucket and filters non-source files', async () => {
  const entries = [{ repo: 'WXYC/a', issue: 1, pr: 2, tier: 'normal', mergeSha: 's1' }];
  const { mutants, summary } = await buildBank(entries, fakeEnv({ runsLocally: true }), { kinds: ['relational'] });
  assert.equal(mutants.length, 1);
  assert.equal(mutants[0].file, 'src/a.ts'); // lockfile dropped
  assert.equal(mutants[0].bucket, GATED);
  assert.match(mutants[0].diff, /<=/); // the rendered hunk the reviewer will judge
  assert.equal(summary.byBucket[GATED], 1);
});

test('buildBank keeps a parse-only mutant when the repo is not gatable', async () => {
  const entries = [{ repo: 'WXYC/b', issue: 3, pr: 4, tier: 'complex', mergeSha: 's2' }];
  const { mutants } = await buildBank(entries, fakeEnv({ runsLocally: false }), { kinds: ['relational'] });
  assert.equal(mutants.length, 1);
  assert.equal(mutants[0].bucket, PARSE_ONLY);
});

test('buildBank excludes an issue whose baseline is red (no mutants, logged)', async () => {
  const entries = [{ repo: 'WXYC/a', issue: 5, pr: 6, tier: 'normal', mergeSha: 's3' }];
  const env = fakeEnv({ runsLocally: true, baselineGreen: true });
  env.prepare = async () => ({ ok: false, reason: 'baseline-red' });
  const { mutants, summary } = await buildBank(entries, env, { kinds: ['relational'] });
  assert.equal(mutants.length, 0);
  assert.equal(summary.excludedIssues.length, 1);
  assert.match(summary.excludedIssues[0].reason, /baseline-red/);
});

test('ALL_KINDS includes off-by-one (the harness default omits it)', () => {
  assert.ok(ALL_KINDS.includes('off-by-one'));
  assert.equal(ALL_KINDS.length, 5);
});

test('buildBank disposes cached clones exactly once after the run', async () => {
  const entries = [
    { repo: 'WXYC/a', issue: 1, pr: 2, tier: 'normal', mergeSha: 's1' },
    { repo: 'WXYC/a', issue: 2, pr: 3, tier: 'normal', mergeSha: 's2' },
  ];
  const env = fakeEnv({ runsLocally: true });
  let disposed = 0;
  env.dispose = () => { disposed += 1; };
  await buildBank(entries, env, { kinds: ['relational'] });
  assert.equal(disposed, 1); // one teardown for the whole run, not per entry
});
