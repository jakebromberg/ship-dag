import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveWaveRecords, rowCovered, WaveRefusal } from './wave-records.mjs';
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
    // A blocking last round needs the operator's finalState (item 5 below).
    assert.equal(derive({ rounds, outcomes: { [REF]: { finalState: 'blocked-hitl' } } }).records[0].reviewVerdict, want);
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

// Rounds on disk for a row that never reached review this wave are not its verdict.
for (const [status, over] of [['skipped', { prNumber: null }], ['failed', { prNumber: null }]]) {
  test(`row status ${status} with no PR ignores rounds on disk`, () => {
    const r = derive({ report: report([row({ status, ...over })]), rounds: [round('', [finding('correctness')]), round('.r2', [])] }).records[0];
    assert.deepEqual([r.reviewVerdict, r.bounces, r.reviewPath], [null, 0, null]);
  });
}

test('a wave with no terminal row records nothing, even with no run id', () => {
  assert.deepEqual(derive({ entry: null, report: report([row({ status: 'pending' })], { configName: undefined }) }).records, []);
});

test('a null row is warned about and skipped; the rest of the wave is recorded', () => {
  const warned = [];
  assert.equal(derive({ report: report([null, row()]) }, { warn: (m) => warned.push(m) }).records.length, 1);
  assert.match(warned.join('\n'), /unknown status/);
});

test('a round gateReview cannot read is blocking, and says why', () => {
  const warned = [];
  assert.equal(derive({ rounds: [round('', null)], outcomes: { [REF]: { finalState: 'blocked-hitl' } } }, { warn: (m) => warned.push(m) }).records[0].reviewVerdict, 'blocking');
  assert.match(warned.join('\n'), new RegExp(`${STEM}\\.json: .*read as blocking`));
});

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
  ['a failed row with no PR', { status: 'failed', prNumber: null, prUrl: null }, ['error', 'deferred', 'rate-limited', null]],
  ['a failed row that still opened a PR', { status: 'failed', prNumber: 625 }, ['pushed', 'merged', null, 625]],
  ['a succeeded row beside a stale digest', {}, ['pushed', 'merged', null, 11]],
];
for (const [name, over, want] of reasonCases) {
  test(`rate-limited digest, ${name}: failureReason ${want[2]}`, () => {
    const r = derive({ report: report([row(over)]), digests: { [REF]: { status: 'failed', failureReason: 'rate-limited' } } }).records[0];
    assert.deepEqual([r.implStatus, r.finalState, r.failureReason, r.pr], want);
  });
}

for (const prNumber of [0, 1.5]) {
  test(`a PR number that is not a positive integer (${prNumber}) is no PR, as routeFailure reads it`, () => {
    const r = derive({ report: report([row({ prNumber })]), outcomes: { [REF]: { pr: 91 } } }).records[0];
    assert.deepEqual([r.pr, r.finalState], [91, 'merged']);
    assert.throws(() => derive({ report: report([row({ prNumber })]), outcomes: { [REF]: { pr: '91' } } }), /half-supplied/);
  });
}

test('rate-limited then merged gives two records, and a re-ingest adds none', () => {
  const digests = { [REF]: { status: 'failed', failureReason: 'rate-limited' } };
  const noPr = row({ status: 'failed', prNumber: null, prUrl: null });
  const first = derive({ report: report([noPr]), digests }).records;
  const second = derive({ digests }, { existing: first }).records;
  assert.equal(second.length, 1);
  assert.deepEqual([second[0].finalState, second[0].failureReason], ['merged', null]);
  assert.equal(derive({ report: report([noPr]), digests }, { existing: [...first, ...second] }).records.length, 0);
});

const MERGED = { runId: 'sd-20261008-1', repo: 'WXYC/dj-site', issue: 1, implStatus: 'pushed', finalState: 'merged', failureReason: null };
const dedupeCases = [
  ['a -w2 config name against a record under the bare run id', { entry: null, report: report([row()], { configName: 'ship-dag-sd-20261008-1-w2' }) }, MERGED],
  ['an existing record with no failureReason key', {}, (({ failureReason, ...rest }) => rest)(MERGED)],
  ['a hand-written record whose repo is cased differently', {}, { ...MERGED, repo: 'wxyc/DJ-Site' }],
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
  const fallback = derive({ entry: null, rounds, outcomes: { [REF]: { finalState: 'blocked-hitl' } } }).records[0];
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
    const outcomes = { [ref]: { finalState: 'blocked-hitl' } };
    const r = deriveWaveRecords(report([row({ ref })]), findWaveContext(dir, [ref]), {}, rounds, outcomes, { warn: () => {} }).records[0];
    assert.deepEqual([r.reviewVerdict, r.policySource], [want, 'sidecar']);
  }
});

test("reviewPath is the last round's path, null with no rounds; the run id is the entry raw", () => {
  const r = derive({ entry: entry({ runId: 'ship-dag-sd-20261008-1-w2' }), rounds: [round('', [finding('correctness')]), round('.r2', [])] }).records[0];
  assert.equal(r.reviewPath, `/s/reviews/${STEM}.r2.json`);
  assert.equal(r.runId, 'ship-dag-sd-20261008-1-w2');
  assert.equal(derive().records[0].reviewPath, null);
});

const REF5 = 'WXYC/dj-site#5';
const REF6 = 'WXYC/dj-site#6';
const prLessCases = [
  // [finalState, hasPr, refused, wantFinalState]
  [undefined, true, false, 'merged'],
  ['merged', true, false, 'merged'],
  ['blocked-hitl', true, false, 'blocked-hitl'],
  ['deferred', true, false, 'deferred'],
  ['error', true, false, 'error'],
  [undefined, false, true],
  ['merged', false, true],
  ['Merged', false, true],
  ['blocked', false, true],
  ['blocked-hitl', false, false, 'blocked-hitl'],
  ['deferred', false, false, 'deferred'],
  ['error', false, false, 'error'],
];
for (const [finalState, hasPr, refused, want] of prLessCases) {
  test(`a succeeded row with ${hasPr ? 'a' : 'no'} PR and outcome finalState ${finalState} ${refused ? 'refuses the wave' : 'is recorded beside the rest of the wave'}`, () => {
    const rows = [row({ ref: REF5, number: 5, ...(hasPr ? {} : { prNumber: null, prUrl: null }) }), row({ ref: REF6, number: 6, prNumber: 7 })];
    const outcomes = finalState ? { [REF5]: { finalState, hitl: { pointB: finalState === 'blocked-hitl' } } } : {};
    // A blocking round on disk for a PR-less #5, which that row must not read as its verdict.
    const rounds = hasPr ? {} : { [REF5]: [{ path: '/s/reviews/WXYC%2Fdj-site%235.json', review: { findings: [finding('correctness')] } }] };
    const go = () => deriveWaveRecords(report(rows), entry({ issues: [] }), {}, rounds, outcomes, { warn: () => {} });
    if (refused) return assert.throws(go, /half-supplied wave: succeeded with no PR in the report or --outcomes, and no --outcomes finalState of blocked-hitl, deferred or error: WXYC\/dj-site#5$/);
    const [five, six] = go().records;
    assert.deepEqual([five.pr, five.ciStatus, five.finalState, five.hitl.pointB], [hasPr ? 11 : null, hasPr ? 'pass' : null, want, finalState === 'blocked-hitl']);
    assert.deepEqual([six.pr, six.ciStatus, six.finalState], [7, 'pass', 'merged']);
    if (!hasPr) assert.deepEqual([five.implStatus, five.reviewVerdict, five.bounces, five.reviewPath], ['error', null, 0, null]);
  });
}

test('a PR-less succeeded row is never a rate-limit death, whatever the row says', () => {
  const rows = [row({ ref: REF5, number: 5, prNumber: null, prUrl: null, failureReason: 'rate-limited' })];
  const outcomes = { [REF5]: { finalState: 'blocked-hitl', hitl: { pointB: true } } };
  const r = derive({ report: report(rows), outcomes, entry: entry({ issues: [] }) }).records[0];
  assert.deepEqual([r.implStatus, r.failureReason], ['error', null]);
});

// ---- #100: the record contract T2a deferred ---------------------------------------------------

const DIGEST = { [REF]: { status: 'failed', failureReason: 'rate-limited' } };
const noPr = row({ status: 'failed', prNumber: null, prUrl: null });
const BLOCKED = [round('', [finding('correctness')])];
const FOUR = [round('', [finding('correctness'), finding('security'), finding('convention'), finding('contract')]), round('.r2', [])];
const HAND = { runId: 'sd-20261008-1', repo: 'WXYC/dj-site', issue: 1, implStatus: 'error', finalState: 'deferred', failureReason: 'rate-limited' };
// The `--outcomes` shape, and the one hand-written records carry: `<category> <file>:<line> <summary>`.
const line = (f) => `${f.category} ${f.file}:${f.line} ${f.summary}`;
const pick = (r) => [r.implStatus, r.failureReason, r.finalState, r.pr];
const blockedNoPr = row({ status: 'blocked', prNumber: null, prUrl: null });
// [name, derive() args, derive() opts, check(records)]
const contractCases = [
  ['1 findings: the worst round\'s blocking summaries as strings, at most 3', { entry: entry({ blockOn: DEFAULT_BLOCK_ON }), rounds: FOUR, outcomes: { [REF]: { finalState: 'merged' } } }, {},
    ([r]) => assert.deepEqual(r.findings, FOUR[0].review.findings.slice(0, 3).map(line))],
  ['1 findings: outcomes.findings wins', { rounds: BLOCKED, outcomes: { [REF]: { finalState: 'merged', findings: ['x'] } } }, {},
    ([r]) => assert.deepEqual(r.findings, ['x'])],
  ['1 findings: nits only is []', { rounds: [round('', [finding('efficiency')])] }, {}, ([r]) => assert.deepEqual(r.findings, [])],
  ['1 findings: of two blocking rounds, the later one\'s are listed (review finding 5)',
    { rounds: [round('', [finding('correctness', { summary: 'A' })]), round('.r2', [finding('correctness', { summary: 'B' })])], outcomes: { [REF]: { finalState: 'blocked-hitl' } } }, {},
    ([r]) => assert.deepEqual(r.findings, ['correctness a.js:1 B'])],
  ['1 findings: an unreadable round before a blocking one does not hide its findings', { rounds: [round('', null), round('.r2', [finding('correctness')]), round('.r3', [])] }, {},
    ([r]) => assert.deepEqual([r.reviewVerdict, r.findings], ['blocking', ['correctness a.js:1 s']])],
  ['1 findings: an unreadable round after a blocking one does not empty its findings', { rounds: [round('', [finding('correctness')]), round('.r2', null)], outcomes: { [REF]: { finalState: 'blocked-hitl' } } }, {},
    ([r]) => assert.deepEqual([r.reviewVerdict, r.findings], ['blocking', ['correctness a.js:1 s']])],
  ['1 findings: a field the gate leaves null is left out, a blank category named as the gate names it',
    { rounds: [round('', [finding('correctness', { line: null }), finding('', { file: null, line: null })])], outcomes: { [REF]: { finalState: 'blocked-hitl' } } }, {},
    ([r]) => assert.deepEqual(r.findings, ['correctness a.js s', '(blank) s'])],
  ['2a a rate-limit death is deferred', { report: report([noPr]), digests: DIGEST }, {}, ([r]) => assert.deepEqual(pick(r), ['error', 'rate-limited', 'deferred', null])],
  ['2a a hand-written deferred/error death is not duplicated (review finding 1)', { report: report([noPr]), digests: DIGEST }, { existing: [HAND], reportId: 'w1' }, (rs) => assert.equal(rs.length, 0)],
  // A clean round on disk for the continuation's PR, which the death must not read.
  ['2b point E: the death and the outcome are both recorded', { report: report([noPr]), digests: DIGEST, rounds: [round('', [])], outcomes: { [REF]: { pr: 12, finalState: 'merged', bounces: 2 } } }, {},
    (rs) => {
      assert.deepEqual(rs.map(pick), [['error', 'rate-limited', 'deferred', null], ['pushed', null, 'merged', 12]]);
      assert.deepEqual(rs.map((r) => [r.bounces, r.reviewVerdict, r.reviewPath]), [[0, null, null], [2, 'clean', `/s/reviews/${STEM}.json`]]);
    }],
  ['2b point E: a death whose continuation reached point B is recorded beside that outcome',
    { report: report([noPr]), digests: DIGEST, outcomes: { [REF]: { finalState: 'blocked-hitl', hitl: { pointB: true } } } }, {},
    (rs) => assert.deepEqual(rs.map((r) => [...pick(r), r.hitl.pointB]), [['error', 'rate-limited', 'deferred', null, false], ['error', null, 'blocked-hitl', null, true]])],
  ['2b point E: an outcome finalState of deferred is the death itself', { report: report([noPr]), digests: DIGEST, outcomes: { [REF]: { finalState: 'deferred' } } }, {},
    (rs) => assert.deepEqual(rs.map(pick), [['error', 'rate-limited', 'deferred', null]])],
  ['2b point E: re-ingesting with the outcome after the death adds only the outcome (review: one death, not two)',
    { report: report([noPr]), digests: DIGEST, outcomes: { [REF]: { finalState: 'blocked-hitl', hitl: { pointB: true } } } }, { reportId: 'w1', existing: [{ ...HAND, implStatus: 'error', reportId: 'w1' }] },
    (rs) => assert.deepEqual(rs.map(pick), [['error', null, 'blocked-hitl', null]])],
  // With no PR and no point B nothing shows a continuation ran, and a quota death must never read as a model failure.
  ...['error', 'blocked-hitl'].map((finalState) => [`2b point E: a finalState ${finalState} with no PR and no point B is the death's own outcome`,
    { report: report([noPr]), digests: DIGEST, outcomes: { [REF]: { finalState } } }, {},
    (rs) => assert.deepEqual(rs.map(pick), [['error', 'rate-limited', finalState, null]])]),
  ['2b point E: a blocked row is no rate-limit death, so only the outcome is recorded', { report: report([blockedNoPr]), digests: DIGEST, outcomes: { [REF]: { pr: 12, finalState: 'merged' } } }, {},
    (rs) => assert.deepEqual(rs.map(pick), [['pushed', null, 'merged', 12]])],
  ['2b point E: re-ingesting adds none', { report: report([noPr]), digests: DIGEST, outcomes: { [REF]: { pr: 12, finalState: 'merged' } } },
    { reportId: 'w1', existing: [{ ...HAND, reportId: 'w1' }, { ...HAND, finalState: 'merged', failureReason: null, reportId: 'w1' }] }, (rs) => assert.equal(rs.length, 0)],
  ['3 a repo without a post-session check records ciStatus none', {}, { noCheckRepos: ['WXYC/dj-site'] }, ([r]) => assert.equal(r.ciStatus, 'none')],
  ['3 a repo with one still records pass', {}, { noCheckRepos: ['WXYC/other'] }, ([r]) => assert.equal(r.ciStatus, 'pass')],
  ['3 a failed row records no ciStatus either way', { report: report([row({ status: 'failed' })]) }, { noCheckRepos: ['WXYC/dj-site'] }, ([r]) => assert.equal(r.ciStatus, null)],
  ['4 complexitySource entry', { entry: entry({ issues: [issueEntry({ complexity: 'complex' })] }) }, {}, ([r]) => assert.deepEqual([r.complexity, r.complexitySource], ['complex', 'entry'])],
  ['4 complexitySource default: a null complexity', { entry: entry({ issues: [issueEntry({ complexity: null })] }) }, {}, ([r]) => assert.deepEqual([r.complexity, r.complexitySource], ['normal', 'default'])],
  ['4 complexitySource default: no entry', { entry: null }, {}, ([r]) => assert.deepEqual([r.complexity, r.complexitySource], ['normal', 'default'])],
  ['5 a PR row whose last round blocks, with a finalState, is recorded', { rounds: BLOCKED, outcomes: { [REF]: { finalState: 'blocked-hitl' } } }, {}, ([r]) => assert.equal(r.finalState, 'blocked-hitl')],
  ['5 a PR row whose last round is clean after a block is merged', { rounds: [...BLOCKED, round('.r2', [])] }, {}, ([r]) => assert.equal(r.finalState, 'merged')],
  ['6 reportId is stamped on each record', {}, { reportId: 'w1' }, ([r]) => assert.equal(r.reportId, 'w1')],
  // A retry re-runs only PR-less failures; every other row is re-listed as it stood, so another reportId is no new event for it.
  ['6 a second rate-limit death under another reportId is a second event', { report: report([noPr]), digests: DIGEST },
    { reportId: 'w2', existing: [{ ...HAND, implStatus: 'error', reportId: 'w1' }] }, (rs) => assert.deepEqual(rs.map((r) => [...pick(r), r.reportId]), [['error', 'rate-limited', 'deferred', null, 'w2']])],
  ['6 a second PR-less error under another reportId is a second event', { report: report([noPr]) },
    { reportId: 'w2', existing: [{ ...MERGED, finalState: 'error', implStatus: 'error', reportId: 'w1' }] }, (rs) => assert.equal(rs.length, 1)],
  ['6 a row with a PR carried over under another reportId is the same event', {}, { reportId: 'w2', existing: [{ ...MERGED, implStatus: 'pushed', pr: 11, reportId: 'w1' }] }, (rs) => assert.equal(rs.length, 0)],
  ['6 a skipped row carried over under another reportId is the same event', { report: report([row({ status: 'skipped', prNumber: null, prUrl: null })]) },
    { reportId: 'w2', existing: [{ ...MERGED, finalState: 'deferred', implStatus: null, reportId: 'w1' }] }, (rs) => assert.equal(rs.length, 0)],
  ['6 the same key under the same reportId is a re-ingest', {}, { reportId: 'w1', existing: [{ ...MERGED, reportId: 'w1' }] }, (rs) => assert.equal(rs.length, 0)],
  ['6 a hand-written record has no reportId, so the key alone applies', {}, { reportId: 'w1', existing: [MERGED] }, (rs) => assert.equal(rs.length, 0)],
  ['6 a record without a reportId against a stamped one: the key alone applies', {}, { existing: [{ ...MERGED, reportId: 'w1' }] }, (rs) => assert.equal(rs.length, 0)],
];
for (const [name, args, opts, check] of contractCases) {
  test(`record contract ${name}`, () => check(derive(args, opts).records));
}

test('record contract 5: a PR row whose last round blocks, with no finalState, is half-supplied and names the ref', () => {
  assert.throws(() => derive({ rounds: BLOCKED }), /^Error: half-supplied wave: .*WXYC\/dj-site#1$/);
});

test('record contract 5: the half-supplied refusal names every ref under each cause, and carries them', () => {
  const rows = [row({ ref: REF5, number: 5, prNumber: null, prUrl: null }), row({ ref: REF6, number: 6, prNumber: null, prUrl: null }), row(), row({ ref: 'WXYC/dj-site#2', number: 2, prNumber: 12 })];
  const rounds = { [REF]: BLOCKED, 'WXYC/dj-site#2': BLOCKED };
  assert.throws(() => deriveWaveRecords(report(rows), entry({ issues: [] }), {}, rounds, {}, { warn: () => {} }), (err) => {
    assert.equal(err.message, 'half-supplied wave: succeeded with no PR in the report or --outcomes, and no --outcomes finalState of blocked-hitl, deferred or error: '
      + 'WXYC/dj-site#5, WXYC/dj-site#6; a PR whose last review round blocks, with no --outcomes finalState: WXYC/dj-site#1, WXYC/dj-site#2');
    assert.deepEqual([err.noPr, err.lastBlocks], [[REF5, REF6], [REF, 'WXYC/dj-site#2']]);
    return true;
  });
});

test('record contract 7: a row without an owner/repo#N ref is malformed, not half-supplied', () => {
  for (const bad of [row({ ref: undefined }), row({ ref: 'dj-site-1' }), row({ ref: 'dj-site#1' })]) {
    assert.throws(() => derive({ report: report([bad]) }), /^Error: malformed report row: /);
  }
});

test('record contract 7: an empty round beside .raw warns and reads as blocking', () => {
  const warned = [];
  const r = derive({ rounds: [round('', [], rawDir)], outcomes: { [REF]: { finalState: 'blocked-hitl' } } }, { warn: (m) => warned.push(m) }).records[0];
  assert.equal(r.reviewVerdict, 'blocking');
  assert.deepEqual(warned, [`${join(rawDir, `${STEM}.json`)}: empty beside .raw; read as blocking`]);
});

// Review finding 6's gaps.
test('a #1 round set listed by reviewRoundFiles ignores a #12 neighbour on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wave-records-neighbour-'));
  writeFileSync(join(dir, `${STEM}.json`), JSON.stringify({ issue: 1, findings: [] }));
  writeFileSync(join(dir, 'WXYC%2Fdj-site%2312.json'), JSON.stringify({ issue: 12, findings: [finding('correctness')] }));
  const rounds = reviewRoundFiles([dir], REF).map(({ path }) => ({ path, review: JSON.parse(readFileSync(path, 'utf8')) }));
  const r = derive({ rounds }).records[0];
  assert.deepEqual([r.reviewVerdict, r.reviewPath], ['clean', join(dir, `${STEM}.json`)]);
});

test('opts.tuningVersion stands in when there is no entry, even at 0', () => {
  assert.equal(derive({ entry: null }, { tuningVersion: 0 }).records[0].tuningVersion, 0);
});

for (const [name, kind, go] of [
  ['a row without an owner/repo#N ref', 'malformed-row', () => derive({ report: report([row({ ref: 'dj-site-1' })]) })],
  ['a wave with no run id', 'no-run-id', () => derive({ entry: null, report: report([row()], { configName: undefined }) })],
  ['a succeeded row with no PR', 'half-supplied', () => derive({ report: report([row({ prNumber: null, prUrl: null })]) })],
  ['a PR row whose last round blocks', 'half-supplied', () => derive({ rounds: BLOCKED })],
]) {
  test(`refusal kind: ${name} is a WaveRefusal of kind ${kind}`, () => {
    assert.throws(go, (err) => err instanceof WaveRefusal && err.kind === kind);
  });
}

// rowCovered asks sameEvent whether a record is the event ingest would derive for the row: a PR-less failure is its
// report's own event, unless both are blocked; any other row recurs unchanged.
{
  const RUN = 'sd-1';
  const report = { id: 'w2', startedAt: Date.parse('2026-10-08T19:00:00Z') };
  const rec = (over = {}) => ({ runId: RUN, repo: 'a/b', issue: 1, ts: '2026-10-08T19:30:00Z', implStatus: 'error', finalState: 'error', pr: null, ...over });
  const pushed = (over = {}) => rec({ implStatus: 'pushed', finalState: 'merged', pr: 11, ...over });
  // Point B: a PR held for a human, recorded under the first report.
  const held = (over = {}) => pushed({ finalState: 'blocked-hitl', reportId: 'w1', ...over });
  const skippedRec = (over = {}) => rec({ implStatus: null, finalState: 'deferred', ...over });
  // Point A: a triage defer, hand-written before the ref ever ran.
  const defer = (finalState) => skippedRec({ finalState, ts: '2026-10-01T00:00:00Z' });
  // Point E: a rate-limit death, hand-written once this report was under way.
  const death = () => rec({ finalState: 'deferred', failureReason: 'rate-limited' });
  const failed = { ref: 'a/b#1', status: 'failed', prNumber: null };
  const merged = { ref: 'a/b#1', status: 'succeeded', prNumber: 11 };
  const findPr = { ...merged, prNumber: null };
  const skipped = { ref: 'a/b#1', status: 'skipped', prNumber: null };
  for (const [name, row, records, want] of [
    ['a PR-less failure with a record carrying this reportId', failed, [rec({ reportId: 'w2' })], true],
    ['a PR-less failure whose only record carries the first report\'s reportId', failed, [rec({ reportId: 'w1' })], false],
    ['a PR-less failure with a hand-written record at or after startedAt', failed, [rec()], true],
    ['a PR-less failure with a hand-written record from exactly startedAt', failed, [rec({ ts: '2026-10-08T19:00:00Z' })], true],
    ['a PR-less failure with a hand-written record from before startedAt', failed, [rec({ ts: '2026-10-08T18:59:59Z' })], false],
    ['a PR-less failure with no record at all', failed, [], false],
    ['a PR-less failure whose record is another run, repo or issue', failed, [rec({ runId: 'sd-2', reportId: 'w2' }), rec({ repo: 'a/c', reportId: 'w2' }), rec({ issue: 2, reportId: 'w2' })], false],
    ['a PR-less failure, repo and run folded by case and suffix', failed, [rec({ runId: 'SD-1-b', repo: 'A/B', reportId: 'w2' })], true],
    ['a PR-less failure whose only records are an earlier pushed and an earlier skipped one', failed, [pushed({ reportId: 'w1' }), skippedRec({ reportId: 'w1' })], false],
    ['a PR-less failure whose only record is the merge that followed it, hand-written', failed, [pushed()], false],
    ['a PR-less failure whose only record is an earlier point-B hold', failed, [held()], false],
    ['a PR-less failure whose PR came from --outcomes, recorded pushed under this report', failed, [pushed({ reportId: 'w2' })], true],
    ['a succeeded row with no PR (find-pr) whose only record is an error under the first report', findPr, [rec({ reportId: 'w1' })], false],
    ['a find-pr row carried over, whose record the first ingest made pushed from --outcomes', findPr, [pushed({ reportId: 'w1' })], true],
    ['a find-pr row whose only record is a triage defer', findPr, [defer('blocked-hitl')], false],
    ['a find-pr row whose only record is an earlier PR-less blocked one', findPr, [rec({ implStatus: 'blocked', reportId: 'w1' })], false],
    ['a PR-less blocked row carried over, recorded blocked under the first report', { ...failed, status: 'blocked' }, [rec({ implStatus: 'blocked', reportId: 'w1' })], true],
    ['a PR-less blocked row whose PR came from --outcomes, recorded pushed under this report', { ...failed, status: 'blocked' }, [pushed({ reportId: 'w2' })], true],
    ['a PR-less blocked row whose only record is a later hand-written blocked merge', { ...failed, status: 'blocked' }, [rec({ implStatus: 'blocked', finalState: 'merged' })], false],
    ['a merged row whose only record is its PR-less failure in the first report (a retry that merged)', merged, [rec({ reportId: 'w1' })], false],
    ['a row with a PR whose only record is an error carrying this reportId', merged, [rec({ reportId: 'w2' })], false],
    ['a row with a PR whose only record is a hand-written error at or after startedAt', merged, [rec()], false],
    ['a row with a PR whose only record is a rate-limit death hand-written after startedAt (its merge not ingested)', merged, [death()], false],
    ['a merged row whose only records are triage defers (blocked-hitl, deferred)', merged, [defer('blocked-hitl'), defer('deferred')], false],
    ['a failed row with a PR whose only records are an earlier skipped one and a triage defer', { ...merged, status: 'failed' }, [skippedRec({ reportId: 'w1' }), defer('deferred')], false],
    ['a carried-over merged row recorded under the first report', merged, [pushed({ reportId: 'w1' })], true],
    ['a carried-over merged row covered by a hand-written record from before the retry', merged, [pushed({ ts: '2026-10-01T00:00:00Z' })], true],
    ['a row with a PR held at point B, recorded blocked-hitl under the first report', merged, [held()], true],
    ['a row with a PR ingested with an --outcomes finalState of error, recorded under the first report', merged, [held({ finalState: 'error' })], true],
    ['a merge whose only record is a point-B hold of another PR', merged, [held({ pr: 10 })], false],
    ['a merge whose only record is an --outcomes error of another PR', merged, [held({ finalState: 'error', pr: 10 })], false],
    ['a merge whose only record is a PR-less blocked hold', merged, [rec({ implStatus: 'blocked', finalState: 'blocked-hitl', reportId: 'w1' })], false],
    ['a carried-over skipped row', skipped, [skippedRec({ reportId: 'w1' })], true],
    ['a skipped row ingested with an --outcomes finalState of blocked-hitl', skipped, [skippedRec({ finalState: 'blocked-hitl', reportId: 'w1' })], true],
    ['a skipped row ingested with an --outcomes finalState of merged', skipped, [skippedRec({ finalState: 'merged', reportId: 'w1' })], true],
    ['a skipped row whose only record is a later merge', skipped, [pushed()], false],
    ['a merged row with no record', merged, [], false],
  ]) {
    test(`rowCovered: ${name} is ${want ? '' : 'not '}covered`, () => {
      assert.equal(rowCovered(row, report, records, RUN), want);
    });
  }

  // One identity: audit names a row exactly when ingest, with these --outcomes and digests, would append a record
  // for it. A row whose last column names a cause is a disagreement rowCovered accepts, as its JSDoc lists:
  // `startedAt` (a hand-written PR-less failure from before the report), `--outcomes` (rowCovered reads a record's
  // finalState, and a find-pr row's PR, as ones --outcomes could have set; so a row it covers may still append
  // under other --outcomes, and a PR-less row whose PR came from --outcomes is named), and `digest` (audit reads no
  // digest, so an error record covers a PR-less failure whatever its rate-limit).
  const blockedRow = { ...failed, status: 'blocked' };
  const rateLimited = { [failed.ref]: { status: 'failed', failureReason: 'rate-limited' } };
  const dead = (over = {}) => rec({ finalState: 'error', failureReason: 'rate-limited', ...over });
  const atB = { [merged.ref]: { finalState: 'blocked-hitl', hitl: { pointB: true } } };
  const asked = (finalState, pr) => ({ [failed.ref]: { finalState, ...(pr ? { pr } : {}) } });
  for (const [name, row, outcomes, digests, records, covered, accepted = null] of [
    ['a triage defer is not the point-B hold of a PR', merged, atB, {}, [defer('blocked-hitl')], false],
    ['a second hold of a new PR is not the first hold', merged, atB, {}, [held({ pr: 10 })], false],
    ['a hold of the same PR is the same event', merged, atB, {}, [held()], true],
    ['a legacy rate-limited error is the death ingest derives as deferred', failed, {}, rateLimited, [dead()], true],
    ['a legacy rate-limited error under the first report is not this report\'s death', failed, {}, rateLimited, [dead({ reportId: 'w1' })], false],
    ['a carried-over merge of the same PR', merged, {}, {}, [pushed({ reportId: 'w1' })], true],
    ['a carried-over merge of another PR', merged, {}, {}, [pushed({ pr: 10, reportId: 'w1' })], true],
    ['a PR-less failure under the first report is not this report\'s', failed, {}, {}, [rec({ reportId: 'w1' })], false],
    ['a PR-less failure under this report', failed, {}, {}, [rec({ reportId: 'w2' })], true],
    ['a skipped row\'s carried-over record', skipped, {}, {}, [skippedRec({ reportId: 'w1' })], true],
    // implStatus: a hand-written merge of the row's PR is the merge, whatever non-null implStatus it was given.
    ['a merge hand-written with implStatus error (wxyc-shared#454)', merged, asked('merged'), {}, [rec({ finalState: 'merged', pr: 11 })], true],
    ['a find-pr row\'s merge hand-written with implStatus blocked (dj-site#1764)', findPr, asked('merged', 11), {}, [rec({ implStatus: 'blocked', finalState: 'merged', pr: 11 })], true],
    ['a find-pr row\'s merge recorded with no PR under the first report', findPr, asked('merged', 11), {}, [rec({ finalState: 'merged', reportId: 'w1' })], true],
    ['a merge record that says rate-limited is not the merge ingest derives', merged, {}, {}, [pushed({ failureReason: 'rate-limited', reportId: 'w2' })], false],
    // failureReason is part of the identity in both.
    ['a deferred record of the PR that says rate-limited is not a plain deferral', merged, asked('deferred'), {}, [pushed({ finalState: 'deferred', failureReason: 'rate-limited' })], false],
    // A PR-less blocked record and a PR-less error are two events across reports, either way round.
    ['a PR-less failure is not the first report\'s PR-less blocked record', failed, {}, {}, [rec({ implStatus: 'blocked', reportId: 'w1' })], false],
    ['a PR-less blocked row is not the first report\'s PR-less failure', blockedRow, {}, {}, [rec({ reportId: 'w1' })], false],
    ['a PR-less blocked row carried over from the first report', blockedRow, {}, {}, [rec({ implStatus: 'blocked', reportId: 'w1' })], true],
    // Only the implStatus-null rule keeps a find-pr row left at point B apart from a triage defer.
    ['a find-pr row left at point B with no PR is not a triage defer', findPr, asked('blocked-hitl'), {}, [defer('blocked-hitl')], false],
    // Accepted disagreements.
    ['a hand-written PR-less failure from before startedAt', failed, {}, {}, [rec({ ts: '2026-10-08T18:59:59Z' })], false, 'startedAt'],
    ['a merge that followed a point-B hold of the same PR', merged, {}, {}, [held()], true, '--outcomes'],
    // Only eventState's failureReason guard keeps an operator-set deferred apart from the error ingest derives.
    ['a PR-less failure against an operator-set deferred', failed, {}, {}, [rec({ finalState: 'deferred' })], true, '--outcomes'],
    ['a PR-less failure whose PR --outcomes supplied, against a hand-written merge', failed, asked(undefined, 11), {}, [pushed()], false, '--outcomes'],
    ['a rate-limit death against a hand-written plain error', failed, {}, rateLimited, [rec()], true, 'digest'],
    ['a plain PR-less failure against a legacy rate-limited error', failed, {}, {}, [dead()], true, 'digest'],
  ]) {
    const ingest = accepted ? `, though ingest ${covered ? 'appends' : 'adds nothing'} (${accepted})` : '';
    test(`one identity: ${name}: audit ${covered ? 'covers' : 'names'} the row${ingest}`, () => {
      const wave = { configName: 'ship-dag-sd-1', finishedAt: '2026-10-08T19:30:00Z', issues: [row] };
      const derived = deriveWaveRecords(wave, { runId: RUN, issues: [] }, digests, {}, outcomes, { existing: records, reportId: 'w2', warn: () => {} }).records;
      assert.equal(rowCovered(row, report, records, RUN), covered);
      assert.equal(derived.length === 0, accepted ? !covered : covered);
    });
  }
}
