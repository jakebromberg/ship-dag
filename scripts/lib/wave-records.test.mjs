import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveWaveRecords } from './wave-records.mjs';
import { reviewRoundFiles } from './review-rounds.mjs';
import { appendWave, findWaveContext } from './wave-sidecar.mjs';
import { DEFAULT_BLOCK_ON } from '../review-gate.mjs';
import { load as loadTuning } from './tuning.mjs';

const REF = 'WXYC/dj-site#1';
const STEM = 'WXYC%2Fdj-site%231';
const row = (over = {}) => ({ ref: REF, number: 1, status: 'succeeded', prUrl: 'https://x/11', prNumber: 11, ...over });
const report = (rows = [row()], over = {}) => ({ configName: 'ship-dag-sd-20261008-1', finishedAt: '2026-10-08T19:30:00.000Z', issues: rows, ...over });
const issueEntry = (over = {}) => ({ ref: REF, complexity: 'normal', effort: 'high', effortSource: 'tuning', model: 'sonnet', ...over });
const entry = (over = {}) => ({ runId: 'sd-20261008-1', wave: 1, tuningVersion: 1, blockOn: ['correctness'], issues: [issueEntry()], ...over });
const finding = (category, over = {}) => ({ category, verdict: 'CONFIRMED', file: 'a.js', line: 1, summary: 's', ...over });
// One round as the caller hands it in: `tag` names the file (`''` is the bare round), null findings is unparseable.
const round = (tag, findings, dir = '/s/reviews') => ({ path: join(dir, `${STEM}${tag}.json`), review: findings === null ? null : { issue: 1, findings } });
const derive = (over = {}, opts = {}) => {
  const a = { report: report(), entry: entry(), digests: {}, rounds: [], outcomes: {}, ...over };
  return deriveWaveRecords(a.report, a.entry, a.digests, { [REF]: a.rounds }, a.outcomes, { warn: () => {}, ...opts });
};
const rawDir = mkdtempSync(join(tmpdir(), 'wave-records-raw-'));
writeFileSync(join(rawDir, `${STEM}.json.raw`), 'salvage');

const verdictCases = [
  ['no review rounds', [], null],
  ['one clean round', [round('', [])], 'clean'],
  ['worst across rounds, the blocking one a later legacy tag', [round('', []), round('.r2', []), round('.pass3-skills', [finding('correctness')])], 'blocking'],
  ['nits beat clean', [round('', []), round('.r2', [finding('efficiency')])], 'nits-only'],
  ['unparseable round is the worst', [round('', []), round('.r2', null)], 'blocking'],
  ['empty round beside a .raw sibling is unreadable', [round('', [], rawDir)], 'blocking'],
];
for (const [name, rounds, want] of verdictCases) {
  test(`reviewVerdict: ${name}`, () => {
    assert.equal(derive({ rounds }).records[0].reviewVerdict, want);
  });
}

test("another ref's rounds are not this ref's", () => {
  const rounds = { [REF]: [round('', [])], 'WXYC/dj-site#12': [{ path: '/s/reviews/WXYC%2Fdj-site%2312.json', review: { findings: [finding('correctness')] } }] };
  assert.equal(deriveWaveRecords(report(), entry(), {}, rounds, {}, { warn: () => {} }).records[0].reviewVerdict, 'clean');
});

// Rounds arrive oldest first, whatever their names: `.iter0` here predates the bare round.
const bounceCases = [
  ['single round', [['', []]], 0],
  ['blocking then clean', [['', [finding('correctness')]], ['-r2', []]], 1],
  ['clean then re-gate after a rebase', [['', []], ['.r2', []]], 0],
  ['blocking, blocking, clean (-iterN)', [['', [finding('correctness')]], ['-iter2', [finding('correctness')]], ['-iter3', []]], 2],
  ['an older legacy round blocked before the bare one', [['.iter0', [finding('correctness')]], ['', []]], 1],
];
for (const [name, rounds, want] of bounceCases) {
  test(`bounces: ${name}`, () => {
    assert.equal(derive({ rounds: rounds.map(([tag, f]) => round(tag, f)) }).records[0].bounces, want);
  });
}

test('rounds listed by reviewRoundFiles count in mtime order, -rN included', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wave-records-rounds-'));
  const files = [[`${STEM}.iter0.json`, [finding('correctness')]], [`${STEM}.json`, [finding('correctness')]], [`${STEM}-r2.json`, []]];
  files.forEach(([name, findings], i) => {
    writeFileSync(join(dir, name), JSON.stringify({ issue: 1, findings }));
    utimesSync(join(dir, name), 1_000 + i, 1_000 + i);
  });
  const rounds = reviewRoundFiles([dir], REF).map(({ path }) => ({ path, review: JSON.parse(readFileSync(path, 'utf8')) }));
  const r = derive({ rounds }).records[0];
  assert.deepEqual([r.bounces, r.reviewVerdict, r.reviewPath], [2, 'blocking', join(dir, `${STEM}-r2.json`)]);
});

test('bounces: outcomes.bounces wins when larger; a meta.trigger disagreement is logged', () => {
  const warned = [];
  const rounds = [round('', [finding('correctness')]), { ...round('.r2', []), review: { findings: [], meta: { trigger: 'rebase' } } }];
  const { records } = derive({ rounds, outcomes: { [REF]: { bounces: 3 } } }, { warn: (m) => warned.push(m) });
  assert.equal(records[0].bounces, 3);
  assert.equal(warned.length, 1);
  assert.equal(derive({ rounds }).records[0].bounces, 1);
});

// A row is recorded only once terminal for this wave; null means no record.
const statusCases = [
  ['pending', {}, null],
  ['running', {}, null],
  ['interrupted', {}, null],
  ['skipped', { prNumber: null }, [null, null, 'deferred']],
  ['succeeded', {}, ['pushed', 'pass', 'merged']],
  ['failed', {}, ['pushed', null, 'merged']],
  ['failed', { prNumber: null }, ['error', null, 'error']],
  ['blocked', { prNumber: null }, ['blocked', null, 'error']],
];
for (const [status, over, want] of statusCases) {
  test(`row status ${status}${over.prNumber === null ? ' with no PR' : ''}: ${want ? want.map(String).join(' / ') : 'no record'}`, () => {
    const { records } = derive({ report: report([row({ status, ...over })]) });
    assert.deepEqual(records.map((r) => [r.implStatus, r.ciStatus, r.finalState]), want ? [want] : []);
  });
}

for (const status of [undefined, 'cancelled']) {
  test(`row status ${status}: not recorded, and warned about as unknown`, () => {
    const warned = [];
    assert.equal(derive({ report: report([row({ status })]) }, { warn: (m) => warned.push(m) }).records.length, 0);
    assert.match(warned.join('\n'), /WXYC\/dj-site#1: unknown status/);
  });
}

// failureReason rides only beside implStatus "error": a rate-limited digest on a row
// that opened a PR (backend#620), or a stale one beside a succeeded row, records null.
const reasonCases = [
  ['a failed row with no PR', { status: 'failed', prNumber: null, prUrl: null }, ['error', 'error', 'rate-limited', null]],
  ['a failed row that still opened a PR', { status: 'failed', prNumber: 625 }, ['pushed', 'merged', null, 625]],
  ['a succeeded row beside a stale digest', {}, ['pushed', 'merged', null, 11]],
];
for (const [name, over, want] of reasonCases) {
  test(`rate-limited digest, ${name}: failureReason ${want[2]}`, () => {
    const r = derive({ report: report([row(over)]), digests: { [REF]: { status: 'failed', failureReason: 'rate-limited' } } }).records[0];
    assert.deepEqual([r.implStatus, r.finalState, r.failureReason, r.pr], want);
  });
}

test('a PR number that is not a positive number is no PR, as routeFailure reads it', () => {
  const r = derive({ report: report([row({ prNumber: 0 })]), outcomes: { [REF]: { pr: 91 } } }).records[0];
  assert.deepEqual([r.pr, r.finalState], [91, 'merged']);
  assert.throws(() => derive({ report: report([row({ prNumber: 0 })]), outcomes: { [REF]: { pr: '91' } } }), /half-supplied/);
});

test('rate-limited then merged gives two records, and a re-ingest adds none', () => {
  const digests = { [REF]: { status: 'failed', failureReason: 'rate-limited' } };
  const noPr = row({ status: 'failed', prNumber: null, prUrl: null });
  const first = derive({ report: report([noPr]), digests }).records;
  const second = derive({ digests }, { existing: first }).records;
  assert.equal(second.length, 1);
  assert.deepEqual([second[0].finalState, second[0].failureReason], ['merged', null]);
  assert.equal(derive({ report: report([noPr]), digests }, { existing: [...first, ...second] }).records.length, 0);
});

const MERGED = { runId: 'sd-20261008-1', repo: 'WXYC/dj-site', issue: 1, finalState: 'merged', failureReason: null };
const dedupeCases = [
  ['a -w2 config name against a record under the bare run id', { entry: null, report: report([row()], { configName: 'ship-dag-sd-20261008-1-w2' }) }, MERGED],
  ['an existing record with no failureReason key', {}, (({ failureReason, ...rest }) => rest)(MERGED)],
];
for (const [name, over, existing] of dedupeCases) {
  test(`dedupe: ${name} adds nothing`, () => {
    assert.equal(derive(over, { existing: [existing] }).records.length, 0);
    assert.equal(derive(over).records.length, 1);
  });
}

test('outcomes supply hitl.pointB, a manual finalState and a missing PR', () => {
  const noPr = row({ prNumber: null, prUrl: null });
  const r = derive({ report: report([noPr]), outcomes: { [REF]: { pr: 91, hitl: { pointB: true }, finalState: 'blocked-hitl' } } }).records[0];
  assert.deepEqual([r.pr, r.hitl, r.finalState], [91, { pointA: false, pointB: true }, 'blocked-hitl']);
});

test('a succeeded row with no PR anywhere refuses the wave', () => {
  assert.throws(() => derive({ report: report([row({ prNumber: null, prUrl: null })]) }), /half-supplied.*WXYC\/dj-site#1/);
});

test('no entry and no configName refuses the wave rather than recording runId null', () => {
  assert.throws(() => derive({ entry: null, report: report([row()], { configName: undefined }) }), /no run id/);
});

test('the record copies effort, effortSource and model from the matching ref; legacy entries give null', () => {
  const r = derive().records[0];
  assert.deepEqual([r.effort, r.effortSource, r.model, r.assignment, r.complexity], ['high', 'tuning', 'sonnet', 'sonnet', 'normal']);
  const legacy = derive({ entry: entry({ issues: [{ ref: REF, complexity: 'complex' }] }) }).records[0];
  assert.deepEqual([legacy.effort, legacy.effortSource, legacy.model, legacy.complexity], [null, null, null, 'complex']);
});

test("the matching entry's blockOn gates the verdict; no entry falls back and is marked", () => {
  const rounds = [round('', [finding('convention')])];
  const own = derive({ rounds }).records[0];
  assert.deepEqual([own.reviewVerdict, own.policySource, own.tuningVersion], ['nits-only', 'sidecar', 1]);
  const fallback = derive({ entry: null, rounds }).records[0];
  assert.ok(DEFAULT_BLOCK_ON.includes('convention'));
  assert.deepEqual([fallback.reviewVerdict, fallback.policySource, fallback.tuningVersion], ['blocking', 'default', loadTuning().version]);
  assert.equal(fallback.runId, 'sd-20261008-1');
});

test("two waves in one sidecar: each record takes the matching entry's blockOn", () => {
  const dir = mkdtempSync(join(tmpdir(), 'wave-records-sidecar-'));
  const OTHER = 'WXYC/dj-site#2';
  appendWave(dir, entry({ wave: 1, blockOn: ['correctness'] }));
  appendWave(dir, entry({ wave: 2, blockOn: ['convention'], issues: [issueEntry({ ref: OTHER })] }));
  for (const [ref, want] of [[REF, 'nits-only'], [OTHER, 'blocking']]) {
    const rounds = { [ref]: [round('', [finding('convention')])] };
    const r = deriveWaveRecords(report([row({ ref })]), findWaveContext(dir, [ref]), {}, rounds, {}, { warn: () => {} }).records[0];
    assert.deepEqual([r.reviewVerdict, r.policySource], [want, 'sidecar']);
  }
});

test("reviewPath is the last round's path, null with no rounds; the run id is the entry raw", () => {
  const r = derive({ entry: entry({ runId: 'ship-dag-sd-20261008-1-w2' }), rounds: [round('', [finding('correctness')]), round('.r2', [])] }).records[0];
  assert.equal(r.reviewPath, `/s/reviews/${STEM}.r2.json`);
  assert.equal(r.runId, 'ship-dag-sd-20261008-1-w2');
  assert.equal(derive().records[0].reviewPath, null);
});
