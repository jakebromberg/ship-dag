// Tests for the corpus builder. Run: node --test "skills/ship-dag/eval/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMergedPRList, stratifyAndSample, buildCorpus } from './corpus.mjs';

test('parseMergedPRList: keeps only PRs with a linked issue, maps fields', () => {
  const out = parseMergedPRList([
    { number: 10, closingIssuesReferences: [{ number: 9 }], changedFiles: 2, additions: 30, title: 'a', mergeCommit: { oid: 'sha10' } },
    { number: 11, closingIssuesReferences: [], changedFiles: 1, additions: 1, title: 'no issue' },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { pr: 10, issue: 9, changedFiles: 2, additions: 30, title: 'a', mergeSha: 'sha10' });
});

test('stratifyAndSample: caps per tier, most-recent-first, all tiers represented', () => {
  const candidates = [
    { pr: 1, changedFiles: 1, additions: 3 },   // mechanical
    { pr: 2, changedFiles: 1, additions: 4 },   // mechanical
    { pr: 3, changedFiles: 1, additions: 5 },   // mechanical
    { pr: 4, changedFiles: 3, additions: 40 },  // normal
    { pr: 5, changedFiles: 8, additions: 400 }, // complex
  ];
  const sampled = stratifyAndSample(candidates, 2);
  const byTier = (t) => sampled.filter((s) => s.tier === t).map((s) => s.pr);
  assert.deepEqual(byTier('mechanical'), [3, 2]); // capped at 2, highest pr first
  assert.deepEqual(byTier('normal'), [4]);
  assert.deepEqual(byTier('complex'), [5]);
});

// A fake gh that branches on argv, so buildCorpus is testable without network.
function fakeGh(fixtures) {
  return (argv) => {
    if (argv[0] === 'repo' && argv[1] === 'view') return JSON.stringify({ defaultBranchRef: { name: fixtures.branch || 'main' } });
    if (argv[0] === 'pr' && argv[1] === 'list') return JSON.stringify(fixtures.list);
    if (argv[0] === 'pr' && argv[1] === 'view') {
      const pr = Number(argv[2]);
      return JSON.stringify({ commits: [{ oid: `first-of-${pr}` }] });
    }
    if (argv[0] === 'api') return `${fixtures.base || 'BASE'}\n`;
    throw new Error(`unexpected gh call: ${argv.join(' ')}`);
  };
}

test('buildCorpus: samples, resolves default branch + baseSha, no warnings on a healthy repo', () => {
  const runGh = fakeGh({
    branch: 'master',
    base: 'base-sha',
    list: [
      { number: 20, closingIssuesReferences: [{ number: 19 }], changedFiles: 1, additions: 2, title: 'mech', mergeCommit: { oid: 'm20' } },
      { number: 21, closingIssuesReferences: [{ number: 18 }], changedFiles: 6, additions: 300, title: 'complex', mergeCommit: { oid: 'm21' } },
    ],
  });
  const corpus = buildCorpus({ repos: ['WXYC/x'], perTier: 2, runGh });
  assert.equal(corpus.entries.length, 2);
  assert.equal(corpus.warnings.length, 0);
  const mech = corpus.entries.find((e) => e.tier === 'mechanical');
  assert.equal(mech.issue, 19);
  assert.equal(mech.defaultBranch, 'master');
  assert.equal(mech.baseSha, 'base-sha');
});

test('buildCorpus: warns when a repo has no linked-issue PRs', () => {
  const runGh = fakeGh({ list: [{ number: 1, closingIssuesReferences: [], changedFiles: 1, additions: 1 }] });
  const corpus = buildCorpus({ repos: ['WXYC/empty'], runGh });
  assert.equal(corpus.entries.length, 0);
  assert.match(corpus.warnings[0], /no merged PRs with linked issues/);
});

test('buildCorpus: drops and warns on an unresolved baseSha (e.g. a root commit)', () => {
  const runGh = (argv) => {
    if (argv[0] === 'repo' && argv[1] === 'view') return JSON.stringify({ defaultBranchRef: { name: 'main' } });
    if (argv[0] === 'pr' && argv[1] === 'list') return JSON.stringify([{ number: 30, closingIssuesReferences: [{ number: 29 }], changedFiles: 1, additions: 2, title: 'x', mergeCommit: { oid: 'm30' } }]);
    if (argv[0] === 'pr' && argv[1] === 'view') return JSON.stringify({ commits: [{ oid: 'first-30' }] });
    if (argv[0] === 'api') return '\n'; // gh --jq prints empty for a root commit → null base
    throw new Error(`unexpected gh call: ${argv.join(' ')}`);
  };
  const corpus = buildCorpus({ repos: ['WXYC/x'], perTier: 2, runGh });
  assert.equal(corpus.entries.length, 0);
  assert.ok(corpus.warnings.some((w) => /dropped — missing baseSha/.test(w)));
});

test('buildCorpus: isolates a failing repo so the others still build', () => {
  const runGh = (argv) => {
    if (argv[0] === 'repo' && argv[1] === 'view') return JSON.stringify({ defaultBranchRef: { name: 'main' } });
    if (argv[0] === 'pr' && argv[1] === 'list') {
      if (argv.includes('WXYC/bad')) throw new Error('gh: repo not found');
      return JSON.stringify([{ number: 40, closingIssuesReferences: [{ number: 39 }], changedFiles: 1, additions: 2, title: 'ok', mergeCommit: { oid: 'm40' } }]);
    }
    if (argv[0] === 'pr' && argv[1] === 'view') return JSON.stringify({ commits: [{ oid: 'first-40' }] });
    if (argv[0] === 'api') return 'base40\n';
    throw new Error(`unexpected gh call: ${argv.join(' ')}`);
  };
  const corpus = buildCorpus({ repos: ['WXYC/bad', 'WXYC/good'], perTier: 2, runGh });
  assert.equal(corpus.entries.length, 1);
  assert.equal(corpus.entries[0].repo, 'WXYC/good');
  assert.ok(corpus.warnings.some((w) => /WXYC\/bad: skipped/.test(w)));
});
