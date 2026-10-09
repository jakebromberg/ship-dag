import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveWaveRecords, roundFilesFor } from './wave-records.mjs';
import { DEFAULT_BLOCK_ON } from '../review-gate.mjs';
import { load as loadTuning } from './tuning.mjs';

const REF = 'WXYC/dj-site#1';
const STEM = 'WXYC%2Fdj-site%231';
const row = (over = {}) => ({ ref: REF, number: 1, status: 'succeeded', prUrl: 'https://x/11', prNumber: 11, ...over });
const report = (rows = [row()]) => ({ configName: 'ship-dag-sd-20261008-1', finishedAt: '2026-10-08T19:30:00.000Z', issues: rows });
const issueEntry = (over = {}) => ({ ref: REF, complexity: 'normal', effort: 'high', effortSource: 'tuning', model: 'sonnet', ...over });
const entry = (over = {}) => ({ runId: 'sd-20261008-1', wave: 1, tuningVersion: 1, blockOn: ['correctness'], issues: [issueEntry()], ...over });
const finding = (category, over = {}) => ({ category, verdict: 'CONFIRMED', file: 'a.js', line: 1, summary: 's', ...over });
const file = (name, findings) => ({ name, review: findings === null ? null : { issue: 1, findings } });
const derive = (over = {}, opts = {}) => {
  const a = { report: report(), entry: entry(), digests: {}, reviewFiles: [], outcomes: {}, ...over };
  return deriveWaveRecords(a.report, a.entry, a.digests, a.reviewFiles, a.outcomes, { stateDir: '/s', warn: () => {}, ...opts });
};


const verdictCases = [
  ['no review files', [], null],
  ['one clean round', [file(`${STEM}.json`, [])], 'clean'],
  ['worst across rounds, rN and legacy tag', [file(`${STEM}.json`, [finding('correctness')]), file(`${STEM}.r2.json`, []), file(`${STEM}.pass3-skills.json`, [finding('efficiency', { verdict: 'PLAUSIBLE' })])], 'blocking'],
  ['nits beat clean', [file(`${STEM}.json`, []), file(`${STEM}.r2.json`, [finding('efficiency')])], 'nits-only'],
  ['#12 files are not #1 rounds', [file(`${STEM}.json`, []), file('WXYC%2Fdj-site%2312.json', [finding('correctness')])], 'clean'],
  ['unparseable round is the worst', [file(`${STEM}.json`, []), file(`${STEM}.r2.json`, null)], 'blocking'],
  ['empty round beside a .raw sibling is unreadable', [file(`${STEM}.json`, []), { name: `${STEM}.json.raw` }], 'blocking'],
  ['empty round with no .raw is clean', [file(`${STEM}.json`, [])], 'clean'],
];
for (const [name, reviewFiles, want] of verdictCases) {
  test(`reviewVerdict: ${name}`, () => {
    assert.equal(derive({ reviewFiles }).records[0].reviewVerdict, want);
  });
}

test('roundFilesFor orders the base, then rN numerically, then tags', () => {
  const names = [`${STEM}.r10.json`, `${STEM}.pass3-skills.json`, `${STEM}.r2.json`, `${STEM}.json`, `${STEM}.json.raw`].map((name) => ({ name }));
  assert.deepEqual(roundFilesFor(REF, names).map((f) => f.name), [`${STEM}.json`, `${STEM}.r2.json`, `${STEM}.r10.json`, `${STEM}.pass3-skills.json`]);
});

const bounceCases = [
  ['single round', [[]], 0],
  ['blocking then clean', [[finding('correctness')], []], 1],
  ['clean then re-gate after a rebase', [[], []], 0],
  ['blocking, blocking, clean', [[finding('correctness')], [finding('correctness')], []], 2],
];
for (const [name, rounds, want] of bounceCases) {
  test(`bounces: ${name}`, () => {
    const reviewFiles = rounds.map((f, i) => file(i ? `${STEM}.r${i + 1}.json` : `${STEM}.json`, f));
    assert.equal(derive({ reviewFiles }).records[0].bounces, want);
  });
}

test('bounces: outcomes.bounces wins when larger; a meta.trigger disagreement is logged', () => {
  const warned = [];
  const reviewFiles = [file(`${STEM}.json`, [finding('correctness')]), { ...file(`${STEM}.r2.json`, []), review: { findings: [], meta: { trigger: 'rebase' } } }];
  const { records } = derive({ reviewFiles, outcomes: { [REF]: { bounces: 3 } } }, { warn: (m) => warned.push(m) });
  assert.equal(records[0].bounces, 3);
  assert.equal(warned.length, 1);
  assert.equal(derive({ reviewFiles }).records[0].bounces, 1);
});

test('a failed row with a PR is routed to review, not recorded as CI fail', () => {
  const r = derive({ report: report([row({ status: 'failed' })]) }).records[0];
  assert.equal(r.implStatus, 'pushed');
  assert.notEqual(r.ciStatus, 'fail');
  assert.equal(r.pr, 11);
});

test('a failed rate-limited row with no PR is an error record carrying the reason', () => {
  const noPr = row({ status: 'failed', prNumber: null, prUrl: null });
  const r = derive({ report: report([noPr]), digests: { [REF]: { failureReason: 'rate-limited' } } }).records[0];
  assert.deepEqual([r.implStatus, r.finalState, r.failureReason, r.pr], ['error', 'error', 'rate-limited', null]);
});

test('rate-limited then merged gives two records, and a re-ingest adds none', () => {
  const noPr = row({ status: 'failed', prNumber: null, prUrl: null });
  const first = derive({ report: report([noPr]), digests: { [REF]: { failureReason: 'rate-limited' } } }).records;
  const second = derive({}, { existing: first }).records;
  assert.equal(second.length, 1);
  assert.equal(second[0].finalState, 'merged');
  assert.equal(derive({ report: report([noPr]), digests: { [REF]: { failureReason: 'rate-limited' } } }, { existing: [...first, ...second] }).records.length, 0);
});

test('outcomes supply hitl.pointB, a manual finalState and a missing PR', () => {
  const noPr = row({ prNumber: null, prUrl: null });
  const r = derive({ report: report([noPr]), outcomes: { [REF]: { pr: 91, hitl: { pointB: true }, finalState: 'blocked-hitl' } } }).records[0];
  assert.deepEqual([r.pr, r.hitl, r.finalState], [91, { pointA: false, pointB: true }, 'blocked-hitl']);
});

test('a succeeded row with no PR anywhere refuses the wave', () => {
  assert.throws(() => derive({ report: report([row({ prNumber: null, prUrl: null })]) }), /half-supplied.*WXYC\/dj-site#1/);
});

test('the record copies effort, effortSource and model from the matching ref; legacy entries give null', () => {
  const r = derive().records[0];
  assert.deepEqual([r.effort, r.effortSource, r.model, r.assignment, r.complexity], ['high', 'tuning', 'sonnet', 'sonnet', 'normal']);
  const legacy = derive({ entry: entry({ issues: [{ ref: REF, complexity: 'complex' }] }) }).records[0];
  assert.deepEqual([legacy.effort, legacy.effortSource, legacy.model, legacy.complexity], [null, null, null, 'complex']);
});

test("the matching entry's blockOn gates the verdict; no entry falls back and is marked", () => {
  const reviewFiles = [file(`${STEM}.json`, [finding('convention')])];
  const own = derive({ reviewFiles }).records[0];
  assert.deepEqual([own.reviewVerdict, own.policySource, own.tuningVersion], ['nits-only', 'sidecar', 1]);
  const fallback = derive({ entry: null, reviewFiles }).records[0];
  assert.ok(DEFAULT_BLOCK_ON.includes('convention'));
  assert.deepEqual([fallback.reviewVerdict, fallback.policySource, fallback.tuningVersion], ['blocking', 'default', loadTuning().version]);
  assert.equal(fallback.runId, 'sd-20261008-1');
});

test('reviewPath is $STATE/reviews/<stem>.json and the run id is the entry raw', () => {
  const r = derive({ entry: entry({ runId: 'ship-dag-sd-20261008-1-w2' }) }).records[0];
  assert.equal(r.reviewPath, `/s/reviews/${STEM}.json`);
  assert.equal(r.runId, 'ship-dag-sd-20261008-1-w2');
});
