// Tests for the report orchestrator's pure helpers. Run: node --test "skills/ship-dag/eval/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jaccardByIssue, gatedCaughtByMutant, compareRecall, compareJaccard, renderReport } from './report.mjs';

// Two variants over the same 2 issues / same frozen bank. `ref` catches every
// gated mutant; `comp` misses one — so recall should favour ref, and the one
// parse-only mutant must be ignored by the gated comparison.
const raw = (variant, catches) => ({
  variant,
  spec: { triage: { model: 'haiku' }, implement: { model: 'sonnet' }, review: { model: variant === 'ref' ? 'opus' : 'sonnet' } },
  prices: { haiku: 5, sonnet: 15, opus: 25 },
  results: [
    {
      repo: 'WXYC/a', issue: 1, tier: 'normal',
      implement: { predFiles: ['x.ts'], goldFiles: ['x.ts'] }, // jaccard 1
      firstPass: { verdict: 'merged', bounced: false },
      review: { mutants: [
        { id: 'relational:0', kind: 'relational', bucket: 'gated', caught: catches['a:relational:0'], valid: true },
        { id: 'boolean:0', kind: 'boolean', bucket: 'parse-only', caught: false, valid: true }, // ignored by gated compare
      ] },
      tokens: { triage: 1e5, implement: 1e6, review: 5e5 },
    },
    {
      repo: 'WXYC/a', issue: 2, tier: 'complex',
      implement: { predFiles: ['y.ts', 'z.ts'], goldFiles: ['y.ts'] }, // jaccard 1/2
      firstPass: { verdict: 'merged', bounced: false },
      review: { mutants: [
        { id: 'equality:0', kind: 'equality', bucket: 'gated', caught: catches['2:equality:0'], valid: true },
      ] },
      tokens: { triage: 1e5, implement: 1e6, review: 5e5 },
    },
  ],
});

const ref = raw('ref', { 'a:relational:0': true, '2:equality:0': true });
const comp = raw('comp', { 'a:relational:0': true, '2:equality:0': false }); // misses the complex-issue mutant

test('jaccardByIssue keys per issue', () => {
  const j = jaccardByIssue(ref);
  assert.equal(j.get('WXYC/a#1'), 1);
  assert.equal(j.get('WXYC/a#2'), 0.5);
});

test('gatedCaughtByMutant includes only gated mutants (parse-only dropped)', () => {
  const g = gatedCaughtByMutant(ref);
  assert.equal(g.size, 2); // the boolean parse-only mutant is excluded
  assert.equal(g.get('WXYC/a#1:relational:0'), true);
  assert.equal(g.get('WXYC/a#2:equality:0'), true);
});

test('compareRecall pairs the shared gated mutants and favours the reference', () => {
  const r = compareRecall(ref, comp);
  assert.equal(r.n, 2); // two common gated mutants
  assert.equal(r.aOnly, 1); // ref caught the one comp missed
  assert.equal(r.bOnly, 0);
  assert.equal(r.better, 'a');
});

test('compareJaccard returns a bootstrap CI over the paired per-issue differences', () => {
  const c = compareJaccard(ref, comp, { seed: 1, iterations: 500 });
  assert.equal(c.n, 2); // two common issues
  assert.equal(c.mean, 0); // identical implement file sets → zero difference
});

test('renderReport produces a readable comparison string', () => {
  const s = renderReport([{ name: 'ref', raw: ref }, { name: 'comp', raw: comp }]);
  assert.match(s, /Reference: ref/);
  assert.match(s, /review recall \(paired, gated\)/);
  assert.match(s, /better=ref/);
  assert.match(s, /implement Jaccard/);
});
