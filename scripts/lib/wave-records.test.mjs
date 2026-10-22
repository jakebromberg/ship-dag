import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carriedOver, deriveWaveRecords, rowCovered, sameEvent, WaveRefusal } from './wave-records.mjs';
import { reviewRoundFiles } from './review-rounds.mjs';
import { appendWave, findWaveContext } from './wave-sidecar.mjs';
import { DEFAULT_BLOCK_ON } from '../review-gate.mjs';
import { load as loadTuning } from './tuning.mjs';
import { outcomeOf } from './log-order.mjs';
import { normalizeRecord } from '../telemetry.mjs';

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

// An engine skip says who deferred it; no other row carries the marker, whatever --outcomes makes of its finalState.
for (const [status, over, outcomes, want] of [
  ['skipped', { prNumber: null }, {}, 'dependency'],
  ['skipped', { prNumber: null }, { finalState: 'blocked-hitl' }, 'dependency'],
  ['failed', { prNumber: null }, {}, undefined],
  ['succeeded', {}, {}, undefined],
]) {
  test(`row status ${status}${outcomes.finalState ? ` with outcome ${outcomes.finalState}` : ''}: skipReason ${want}`, () => {
    const { records } = derive({ report: report([row({ status, ...over })]), outcomes: { [REF]: outcomes } });
    assert.equal(records[0].skipReason, want);
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

// An engine stop (memory-critical, lease-wait) rides the row's own failureReason, as rate-limited does, and is infrastructure,
// not a model failure: a PR-less terminal row is a deferred "error" death; a launch-stopped pending row never reached implement.
const stop = (failureReason, stopStage, status, over = {}) => row({ status, prNumber: null, prUrl: null, failureReason, stopStage, ...over });
// [name, row, outcomes, want [implStatus, failureReason, finalState, pr] of each record]
const stopCases = [
  ['lease-wait, failed, no PR', stop('lease-wait', 'session', 'failed'), {}, [['error', 'lease-wait', 'deferred', null]]],
  ['memory-critical post-check, failed, no PR', stop('memory-critical', 'post-check', 'failed'), {}, [['error', 'memory-critical', 'deferred', null]]],
  ['memory-critical retry, failed, with a PR: gated, not dead', stop('memory-critical', 'retry', 'failed', { prNumber: 625 }), {}, [['pushed', null, 'merged', 625]]],
  ['a pending launch stop with no outcome: no record', stop('memory-critical', 'launch', 'pending'), {}, []],
  ['a pending launch stop the user deferred', stop('memory-critical', 'launch', 'pending'), { [REF]: { finalState: 'deferred' } }, [[null, 'memory-critical', 'deferred', null]]],
  ['a pending launch stop the run stopped at point F', stop('memory-critical', 'launch', 'pending'), { [REF]: { finalState: 'deferred' } }, [[null, 'memory-critical', 'deferred', null]]],
  ['a pending row with no failureReason is still not yet terminal', stop(null, null, 'pending'), { [REF]: { finalState: 'deferred' } }, []],
  ['a succeeded row beside a lease-wait it left behind is no stop', stop('lease-wait', 'session', 'succeeded', { prNumber: 11 }), {}, [['pushed', null, 'merged', 11]]],
  ['a lease-wait death resumed in place, continuation PR from --outcomes', stop('lease-wait', 'session', 'failed'), { [REF]: { pr: 12 } }, [['error', 'lease-wait', 'deferred', null], ['pushed', null, 'merged', 12]]],
];
for (const [name, r, outcomes, want] of stopCases) {
  test(`engine stop: ${name}`, () => {
    const { records } = derive({ report: report([r]), outcomes });
    assert.deepEqual(records.map((rec) => [rec.implStatus, rec.failureReason, rec.finalState, rec.pr]), want);
  });
}

test('engine stop: a pending launch stop re-listed by a later report is one record', () => {
  const stopped = stop('memory-critical', 'launch', 'pending');
  const outcomes = { [REF]: { finalState: 'deferred' } };
  const first = derive({ report: report([stopped]), outcomes }, { reportId: 'w1' }).records;
  assert.equal(derive({ report: report([stopped]), outcomes }, { reportId: 'w2', existing: first }).records.length, 0);
});

for (const [reason, stage] of [['lease-wait', 'session'], ['memory-critical', 'post-check']]) {
  test(`engine stop: a resumed ${reason} death is not covered by its continuation alone`, () => {
    const stopped = stop(reason, stage, 'failed');
    const outcomes = { [REF]: { pr: 12 } };
    const [death, continuation] = derive({ report: report([stopped]), outcomes }, { reportId: 'w1' }).records;
    const covers = (records) => rowCovered(stopped, { id: 'w1', startedAt: 0 }, records, 'sd-20261008-1', undefined);
    assert.deepEqual([covers([continuation]), covers([death, continuation])], [false, true]);
  });
}

test('engine stop: rowCovered counts the record it derives as covering a lease-wait row', () => {
  const stopped = stop('lease-wait', 'session', 'failed');
  const records = derive({ report: report([stopped]) }, { reportId: 'w1' }).records;
  assert.equal(rowCovered(stopped, { id: 'w1', startedAt: 0 }, records, 'sd-20261008-1', undefined), true);
});

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

test('outcomes pressureOverride: true reaches the record, and is absent otherwise', () => {
  assert.equal(derive({ outcomes: { [REF]: { pressureOverride: true } } }).records[0].pressureOverride, true);
  for (const outcomes of [{}, { [REF]: {} }, { [REF]: { pressureOverride: false } }, { [REF]: { pressureOverride: 'yes' } }]) {
    assert.equal('pressureOverride' in derive({ outcomes }).records[0], false);
  }
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
// A derived record's finding: the gate's summary line with the structured category and verdict beside it.
const found = (f) => ({ category: f.category, verdict: f.verdict, summary: line(f) });
const pick = (r) => [r.implStatus, r.failureReason, r.finalState, r.pr];
const blockedNoPr = row({ status: 'blocked', prNumber: null, prUrl: null });
// [name, derive() args, derive() opts, check(records)]
const contractCases = [
  ['1 findings: every blocking finding of the worst round as {category, verdict, summary}, uncapped', { entry: entry({ blockOn: DEFAULT_BLOCK_ON }), rounds: FOUR, outcomes: { [REF]: { finalState: 'merged' } } }, {},
    ([r]) => assert.deepEqual(r.findings, FOUR[0].review.findings.map(found))],
  ['1 findings: more blocking findings than the gate lists inline are all recorded', { entry: entry({ blockOn: DEFAULT_BLOCK_ON }), rounds: [round('', Array.from({ length: 5 }, (_, i) => finding('correctness', { summary: `s${i}` })))], outcomes: { [REF]: { finalState: 'blocked-hitl' } } }, {},
    ([r]) => assert.deepEqual(r.findings.map((f) => f.summary), [0, 1, 2, 3, 4].map((i) => `correctness a.js:1 s${i}`))],
  ['1 findings: an unknown category and a non-CONFIRMED verdict are recorded as the reviewer wrote them',
    { rounds: [round('', [finding('test quality', { verdict: 'PLAUSIBLE' }), finding('', { verdict: undefined, file: null, line: null })])], outcomes: { [REF]: { finalState: 'blocked-hitl' } } }, {},
    ([r]) => assert.deepEqual(r.findings, [{ category: 'test quality', verdict: 'PLAUSIBLE', summary: 'test quality a.js:1 s' }, { category: null, verdict: null, summary: '(blank) s' }])],
  ['1 findings: a nits-only round records no blocking findings', { rounds: [round('', [finding('efficiency'), finding('convention', { verdict: 'PLAUSIBLE' })])] }, {},
    ([r]) => assert.deepEqual(r.findings, [])],
  ['1 findings: --outcomes strings stay strings', { rounds: BLOCKED, outcomes: { [REF]: { finalState: 'merged', findings: ['correctness a.js:1 s'] } } }, {},
    ([r]) => assert.deepEqual(r.findings, ['correctness a.js:1 s'])],
  ['1 findings: outcomes.findings wins', { rounds: BLOCKED, outcomes: { [REF]: { finalState: 'merged', findings: ['x'] } } }, {},
    ([r]) => assert.deepEqual(r.findings, ['x'])],
  ['1 findings: nits only is []', { rounds: [round('', [finding('efficiency')])] }, {}, ([r]) => assert.deepEqual(r.findings, [])],
  ['1 findings: of two blocking rounds, the later one\'s are listed (review finding 5)',
    { rounds: [round('', [finding('correctness', { summary: 'A' })]), round('.r2', [finding('correctness', { summary: 'B' })])], outcomes: { [REF]: { finalState: 'blocked-hitl' } } }, {},
    ([r]) => assert.deepEqual(r.findings, [found(finding('correctness', { summary: 'B' }))])],
  ['1 findings: an unreadable round before a blocking one does not hide its findings', { rounds: [round('', null), round('.r2', [finding('correctness')]), round('.r3', [])] }, {},
    ([r]) => assert.deepEqual([r.reviewVerdict, r.findings], ['blocking', [found(finding('correctness'))]])],
  ['1 findings: an unreadable round after a blocking one does not empty its findings', { rounds: [round('', [finding('correctness')]), round('.r2', null)], outcomes: { [REF]: { finalState: 'blocked-hitl' } } }, {},
    ([r]) => assert.deepEqual([r.reviewVerdict, r.findings], ['blocking', [found(finding('correctness'))]])],
  ['1 findings: a field the gate leaves null is left out, a blank category named as the gate names it',
    { rounds: [round('', [finding('correctness', { line: null }), finding('', { file: null, line: null })])], outcomes: { [REF]: { finalState: 'blocked-hitl' } } }, {},
    ([r]) => assert.deepEqual(r.findings.map((f) => f.summary), ['correctness a.js s', '(blank) s'])],
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
  const death = (over = {}) => rec({ finalState: 'deferred', failureReason: 'rate-limited', ...over });
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
  // for it. rowCovered is handed the row's digest as ingest reads it. A row whose last column names a cause is a
  // disagreement rowCovered accepts, as its JSDoc lists: `startedAt` (a hand-written PR-less failure from before the
  // report) and `--outcomes` (rowCovered reads a record's finalState, and a find-pr row's PR, as ones --outcomes
  // could have set; so a row it covers may still append under other --outcomes, and a PR-less row whose PR came from
  // --outcomes is named).
  const blockedRow = { ...failed, status: 'blocked' };
  const rateLimited = { [failed.ref]: { status: 'failed', failureReason: 'rate-limited' } };
  const timedOut = { [failed.ref]: { status: 'failed', failureReason: 'timeout' } };
  const deathE = { ...failed, failureReason: 'rate-limited' };
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
    // A record carrying a reportId is derived, so its ts is no reason to doubt it: w1's blocked record predates w2.
    ['a PR-less blocked row carried over from the first report', blockedRow, {}, {}, [rec({ implStatus: 'blocked', reportId: 'w1', ts: '2026-10-08T18:00:00Z' })], true],
    // A hand-written record may hold its PR as `owner/repo#N` or a PR URL: the PR is its number.
    ['a hand-written deferral holding its PR as owner/repo#N', merged, asked('deferred'), {}, [pushed({ finalState: 'deferred', pr: 'a/b#11' })], true],
    ['a hand-written deferral holding its PR as a numeric string', merged, asked('deferred'), {}, [pushed({ finalState: 'deferred', pr: '11' })], true],
    ['a hand-written deferral holding its PR as a URL', merged, asked('deferred'), {}, [pushed({ finalState: 'deferred', pr: 'https://github.com/a/b/pull/11' })], true],
    ['a find-pr row against a hand-written deferral holding its PR as a URL', findPr, asked('deferred', 11), {}, [pushed({ finalState: 'deferred', pr: 'https://github.com/a/b/pull/11' })], true],
    ['a find-pr row against an older hand-written deferral of its PR as owner/repo#N', findPr, asked('deferred', 11), {}, [pushed({ finalState: 'deferred', pr: 'a/b#11', ts: '2026-10-01T00:00:00Z' })], true],
    ['a hand-written deferral holding another PR as owner/repo#N', merged, asked('deferred'), {}, [pushed({ finalState: 'deferred', pr: 'a/b#111' })], false],
    ['a hand-written deferral whose PR string is no PR form, though it ends in the number', merged, asked('deferred'), {}, [pushed({ finalState: 'deferred', pr: 'draft-11' })], false],
    ['a find-pr row against a hand-written deferral whose PR is no PR form', findPr, asked('deferred', 11), {}, [pushed({ finalState: 'deferred', pr: 'draft-11' })], false],
    // A merge folds with any merge (sameEvent), so the record's PR, however written, does not keep it apart.
    ['a find-pr row against a merge recorded with another repo\'s PR', findPr, asked('merged', 11), {}, [pushed({ pr: 'x/y#11' })], true],
    ['a find-pr row against a merge recorded with a PR value that is no PR', findPr, asked('merged', 11), {}, [pushed({ pr: 'draft-11' })], true],
    ['a find-pr row against a deferral of the same number in another repo', findPr, asked('deferred', 11), {}, [pushed({ finalState: 'deferred', pr: 'x/y#11' })], false],
    ['a hand-written deferral holding its PR as owner/repo#N in another case', merged, asked('deferred'), {}, [pushed({ finalState: 'deferred', pr: 'A/B#11' })], true],
    ['a hand-written deferral holding the same number in another repo', merged, asked('deferred'), {}, [pushed({ finalState: 'deferred', pr: 'x/y#11' })], false],
    // Only the implStatus-null rule keeps a find-pr row left at point B apart from a triage defer.
    ['a find-pr row left at point B with no PR is not a triage defer', findPr, asked('blocked-hitl'), {}, [defer('blocked-hitl')], false],
    // Accepted disagreements.
    ['a hand-written PR-less failure from before startedAt', failed, {}, {}, [rec({ ts: '2026-10-08T18:59:59Z' })], false, 'startedAt'],
    ['a merge that followed a point-B hold of the same PR', merged, {}, {}, [held()], true, '--outcomes'],
    // Only eventState's failureReason guard keeps an operator-set deferred apart from the error ingest derives.
    ['a PR-less failure against an operator-set deferred', failed, {}, {}, [rec({ finalState: 'deferred' })], true, '--outcomes'],
    ['a PR-less failure whose PR --outcomes supplied, against a hand-written merge', failed, asked(undefined, 11), {}, [pushed()], false, '--outcomes'],
    // The S6 guard: a rate-limit death left at point B is not the deferred death, though no --outcomes keeps it apart.
    ['a rate-limit death against a hand-written deferred death', failed, asked('blocked-hitl'), rateLimited, [death()], true, '--outcomes'],
    // The rate-limit is the digest's, else the row's own, as ingest reads it; never the record's.
    ['a rate-limit death against a hand-written plain error', failed, {}, rateLimited, [rec()], false],
    ['a plain PR-less failure against a legacy rate-limited error', failed, {}, {}, [dead()], false],
    ['a row that says rate-limited, with no digest, against a hand-written plain error', deathE, {}, {}, [rec()], false],
    ['a row that says rate-limited, with no digest, against a legacy rate-limited error', deathE, {}, {}, [dead()], true],
    ['a row that says rate-limited, with no digest, against the deferred death', deathE, {}, {}, [death()], true],
    ['a row that says rate-limited, whose digest says otherwise, against a plain error', deathE, {}, timedOut, [rec()], true],
    ['a row that says rate-limited, whose digest says otherwise, against a legacy rate-limited error', deathE, {}, timedOut, [dead()], false],
    ['a find-pr row that says rate-limited is no death: its own record left at point B', { ...findPr, failureReason: 'rate-limited' }, atB, {}, [rec({ finalState: 'blocked-hitl', reportId: 'w2' })], true],
    ['a find-pr row is no death: its own record left at point B that says rate-limited', findPr, atB, {}, [rec({ finalState: 'blocked-hitl', failureReason: 'rate-limited', reportId: 'w2' })], false],
    ['a rate-limited row with a PR is gated, not dead, against a hand-written rate-limited deferral', { ...merged, status: 'failed' }, asked('deferred'), rateLimited, [pushed({ finalState: 'deferred', failureReason: 'rate-limited' })], false],
    // A resumed death derives the death and its continuation, so the continuation alone covers nothing.
    ['a resumed death whose continuation merged a PR, with only the continuation', failed, asked(undefined, 11), rateLimited, [pushed({ reportId: 'w2' })], false],
    ['a resumed death whose continuation merged a PR, with the death and the continuation', failed, asked(undefined, 11), rateLimited, [death({ reportId: 'w2' }), pushed({ reportId: 'w2' })], true],
    ['a resumed death left at point B, with only the continuation', failed, atB, rateLimited, [rec({ finalState: 'blocked-hitl', reportId: 'w2' })], false],
    // A blocked row is no death, rate-limited or not: ingest derives its one record, with the PR --outcomes gave.
    ['a rate-limited blocked row whose PR came from --outcomes, recorded pushed under this report', blockedRow, asked(undefined, 11), rateLimited, [pushed({ reportId: 'w2' })], true],
    ['a resumed death left at point B, with the death and the continuation', failed, atB, rateLimited, [death({ reportId: 'w2' }), rec({ finalState: 'blocked-hitl', reportId: 'w2' })], true],
    // A find-pr row's PR is the record's, whichever report it carries.
    ['a find-pr row carried over at its first report\'s point-B hold', findPr, { [findPr.ref]: { pr: 5, finalState: 'blocked-hitl', hitl: { pointB: true } } }, {}, [held({ pr: 5, ts: '2026-10-08T18:00:00Z' })], true],
    ['a find-pr row left at point B with no PR, against its own record', findPr, asked('blocked-hitl'), {}, [rec({ finalState: 'blocked-hitl', reportId: 'w2' })], true],
    ['a find-pr row deferred with no PR, against its own record', findPr, asked('deferred'), {}, [rec({ finalState: 'deferred', reportId: 'w2' })], true],
  ]) {
    const ingest = accepted ? `, though ingest ${covered ? 'appends' : 'adds nothing'} (${accepted})` : '';
    test(`one identity: ${name}: audit ${covered ? 'covers' : 'names'} the row${ingest}`, () => {
      const wave = { configName: 'ship-dag-sd-1', finishedAt: '2026-10-08T19:30:00Z', issues: [row] };
      const derived = deriveWaveRecords(wave, { runId: RUN, issues: [] }, digests, {}, outcomes, { existing: records, reportId: 'w2', warn: () => {} }).records;
      assert.equal(rowCovered(row, report, records, RUN, digests[row.ref]), covered);
      assert.equal(derived.length === 0, accepted ? !covered : covered);
    });
  }
}

// A report row that carries `ran` (the engine launched an implement session for it) separates the folds sameEvent
// keeps for rows that do not: each scenario ingests the first report's row, then asks what the second report's row
// adds and whether audit's rowCovered agrees, before and after that ingest.
{
  const RUN = 'sd-1';
  const R2 = { id: 'w2', startedAt: Date.parse('2026-10-08T19:00:00Z') };
  const at = (rows) => ({ configName: 'ship-dag-sd-1', finishedAt: '2026-10-08T19:30:00Z', issues: rows });
  const setUp = { ref: 'a/b#1', status: 'failed', prNumber: null };
  const merged = { ref: 'a/b#1', status: 'succeeded', prNumber: 11 };
  const skipped = { ref: 'a/b#1', status: 'skipped', prNumber: null };
  const ranTrue = (r) => ({ ...r, ran: true });
  const ranFalse = (r) => ({ ...r, ran: false });
  for (const [name, first, second, added] of [
    ['a first report\'s worktree-setup failure (ran false, no earlier event) is recorded', null, ranFalse(setUp), 1],
    ['a retry report\'s repeated worktree-setup failure is a second event', ranFalse(setUp), ranFalse(setUp), 1],
    ['a merge carried over by a ran-false row is one event', ranTrue(merged), ranFalse(merged), 0],
    ['a merge of the same PR re-run (ran true) is a second event', ranTrue(merged), ranTrue(merged), 1],
    ['a merge of another PR (ran true) is a second event', ranTrue(merged), ranTrue({ ...merged, prNumber: 12 }), 1],
    ['a skipped row carried over by a ran-false row is one event', ranFalse(skipped), ranFalse(skipped), 0],
    ['a skipped row the first report launched nothing for, then skipped again after a launch (ran true)', ranFalse(skipped), ranTrue(skipped), 1],
    ['a ran-false row whose status differs from the first report\'s is its own event', ranTrue(setUp), ranFalse(skipped), 1],
    ['a ran-false row whose PR differs from the first report\'s is its own event', ranTrue(merged), ranFalse({ ...merged, prNumber: 12 }), 1],
    ['a row with no ran, carried over, is one event as before', merged, merged, 0],
    ['a row with no ran, then the same merge re-run (ran true), is a second event: the probe carries ran', merged, ranTrue(merged), 1],
  ]) {
    test(`ran: ${name}`, () => {
      const earlier = first ? [at([first])] : [];
      const logged = first ? deriveWaveRecords(earlier[0], { runId: RUN, issues: [] }, {}, {}, {}, { reportId: 'w1', warn: () => {} }).records : [];
      const { records } = deriveWaveRecords(at([second]), { runId: RUN, issues: [] }, {}, {}, {}, { existing: logged, reportId: 'w2', earlier, warn: () => {} });
      assert.equal(records.length, added);
      assert.equal(rowCovered(second, R2, logged, RUN, undefined, earlier), added === 0);
      assert.equal(rowCovered(second, R2, [...logged, ...records], RUN, undefined, earlier), true);
    });
  }

  test('an engine-died row resumed to a point-B hold and deferred records the death and its continuation', () => {
    const row = { ref: 'a/b#1', status: 'failed', prNumber: null, failureReason: 'engine-died' };
    const { records } = deriveWaveRecords(at([row]), { runId: RUN, issues: [] }, {}, {}, { 'a/b#1': { hitl: { pointB: true }, finalState: 'deferred' } }, { reportId: 'w1', warn: () => {} });
    assert.deepEqual(records.map((r) => [r.finalState, r.failureReason ?? null, Boolean(r.hitl?.pointB)]), [['deferred', 'engine-died', false], ['deferred', null, true]]);
  });

  test('a pending row stamped engine-died is recorded once --outcomes ends it, as a launch stop is', () => {
    const row = { ref: 'a/b#1', status: 'pending', prNumber: null, failureReason: 'engine-died' };
    assert.equal(deriveWaveRecords(at([row]), { runId: RUN, issues: [] }, {}, {}, {}, { reportId: 'w1', warn: () => {} }).records.length, 0);
    const { records } = deriveWaveRecords(at([row]), { runId: RUN, issues: [] }, {}, {}, { 'a/b#1': { finalState: 'deferred' } }, { reportId: 'w1', warn: () => {} });
    assert.deepEqual(records.map((r) => [r.finalState, r.failureReason]), [['deferred', 'engine-died']]);
  });

  // engineDeaths: claude-orchestrator#315's `[{at}]` on a report row, oldest first, omitted when empty. The store is never
  // cleared, so a later report re-lists every death. The second report's `ran` is true throughout: a row relaunched.
  const D1 = '2026-10-08T17:00:00.000Z';
  const D2 = '2026-10-08T18:00:00.000Z';
  const died = (...ats) => ({ engineDeaths: ats.map((a) => ({ at: a })) });
  const failedRow = { ref: 'a/b#1', status: 'failed', prNumber: null };
  const stamped = { ...failedRow, failureReason: 'engine-died' };
  const wave = (rows, existing = [], reportId = 'w1', warn = () => {}) => deriveWaveRecords(at(rows), { runId: RUN, issues: [] }, {}, {}, {}, { existing, reportId, warn }).records;
  const shape = (records) => records.map((r) => [r.ts, r.implStatus, r.finalState, r.failureReason ?? null, r.pr ?? null]);
  const DEATH = (ts) => [ts, 'error', 'deferred', 'engine-died', null];
  const REPORT_TS = '2026-10-08T19:30:00Z';
  for (const [name, first, second, want] of [
    ['no engineDeaths: the outcome alone, as before', [merged], null, [[REPORT_TS, 'pushed', 'merged', null, 11]]],
    ['an empty engineDeaths: the outcome alone', [{ ...merged, engineDeaths: [] }], null, [[REPORT_TS, 'pushed', 'merged', null, 11]]],
    ['one death then success: the death, then the merge as its continuation', [{ ...merged, ...died(D1) }], null, [DEATH(D1), [REPORT_TS, 'pushed', 'merged', null, 11]]],
    ['two deaths: two death records in order, then the continuation', [{ ...merged, ...died(D1, D2) }], null, [DEATH(D1), DEATH(D2), [REPORT_TS, 'pushed', 'merged', null, 11]]],
    ['a death then a model failure: the failure stays a model error', [{ ...failedRow, ...died(D1) }], null, [DEATH(D1), [REPORT_TS, 'error', 'error', null, null]]],
    ['a later report that re-lists the death adds only the continuation', [{ ...merged, ...died(D1) }], [{ ...failedRow, ...died(D1) }], [[REPORT_TS, 'error', 'error', null, null]]],
    ['a later report that re-lists one death and adds another records the new one', [{ ...merged, ...died(D1) }], [{ ...failedRow, ...died(D1, D2) }], [DEATH(D2), [REPORT_TS, 'error', 'error', null, null]]],
    ['a death then an engine skip: the death carries no skipReason', [{ ref: 'a/b#1', status: 'skipped', prNumber: null, ...died(D1) }], null, [DEATH(D1), [REPORT_TS, null, 'deferred', null, null]]],
    // A marker is written at the engine's next start, so it is always an earlier death than a stamped report's own.
    ['a hand-stamped row that also lists an earlier death keeps its own death', [{ ...stamped, ...died(D1) }], null, [DEATH(D1), DEATH(REPORT_TS)]],
    ['a hand-stamped row with two earlier deaths is three deaths', [{ ...stamped, ...died(D1, D2) }], null, [DEATH(D1), DEATH(D2), DEATH(REPORT_TS)]],
  ]) {
    test(`engineDeaths: ${name}`, () => {
      const logged = second ? wave(first) : [];
      const records = wave(second ?? first, logged, second ? 'w2' : 'w1');
      assert.deepEqual(shape(records), want);
      const deaths = records.filter((r) => r.failureReason === 'engine-died');
      for (const rec of records) assert.doesNotThrow(() => normalizeRecord(rec, () => REPORT_TS));
      for (const rec of deaths) assert.deepEqual([outcomeOf(rec), rec.findings, 'skipReason' in rec], ['engine-died', [], false]);
    });
  }

  // The same report ingested again once its row lists an earlier death: the death is new, and the row's own record is already held.
  for (const [name, logged, want] of [
    ['a hand-stamped death', wave([stamped]), [DEATH(D1)]],
    // As without engineDeaths, the legacy model error is superseded by the death it was (legacyDeath).
    ['a legacy model error', wave([stamped]).map((r) => ({ ...r, failureReason: null, finalState: 'error' })), [DEATH(D1), DEATH(REPORT_TS)]],
  ]) {
    test(`engineDeaths: ${name} already logged for the same report is not the earlier death its row lists`, () => {
      assert.deepEqual(shape(wave([{ ...stamped, ...died(D1) }], logged)), want);
    });
  }

  // A relaunch of the same config: the stamped report's death is the marker the relaunch writes, dated by the relaunch.
  const B = '2026-10-08T20:00:00.000Z';
  const R2_TS = '2026-10-08T21:00:00Z';
  const later = (rows, existing, earlier) => deriveWaveRecords({ ...at(rows), finishedAt: R2_TS }, { runId: RUN, issues: [] }, {}, {}, {}, { existing, reportId: 'w2', earlier, warn: () => {} }).records;
  for (const [name, first, second, want] of [
    ['a stamped death is the marker its relaunch lists', [stamped], [{ ...merged, ...died(B) }], [[R2_TS, 'pushed', 'merged', null, 11]]],
    ['a stamped death with an earlier one is the marker after it', [{ ...stamped, ...died(D1) }], [{ ...merged, ...died(D1, B) }], [[R2_TS, 'pushed', 'merged', null, 11]]],
    ['a marker after a death the log holds by its at is a new death', [{ ...merged, ...died(D1) }], [{ ...failedRow, ...died(D1, B) }], [DEATH(B), [R2_TS, 'error', 'error', null, null]]],
    ['a stamped death is held by one marker only', [stamped], [{ ...merged, ...died(D1, D2, B) }], [DEATH(D1), DEATH(D2), [R2_TS, 'pushed', 'merged', null, 11]]],
  ]) {
    test(`engineDeaths: relaunch: ${name}`, () => {
      assert.deepEqual(shape(later(second, wave(first), [at(first)])), want);
    });
  }

  // The relaunch fold needs the stamped report among `earlier`, of the same config: another config of the run family keeps its own death store.
  for (const [name, firstReport, second, want] of [
    ['a first marker after another config\'s death is a new death', { ...at([{ ...merged, ...died(D1) }]), configName: 'ship-dag-sd-1-r2' }, [{ ...failedRow, ...died(B) }], [DEATH(B), [R2_TS, 'error', 'error', null, null]]],
    ['a first marker after another config\'s stamped death is a new death', { ...at([stamped]), configName: 'ship-dag-sd-1-r2' }, [{ ...failedRow, ...died(B) }], [DEATH(B), [R2_TS, 'error', 'error', null, null]]],
    ['a first marker after a hand-written death no report holds is a new death', null, [{ ...failedRow, ...died(B) }], [DEATH(B), [R2_TS, 'error', 'error', null, null]]],
  ]) {
    test(`engineDeaths: relaunch: ${name}`, () => {
      const logged = firstReport ? deriveWaveRecords(firstReport, { runId: RUN, issues: [] }, {}, {}, {}, { reportId: 'w1', warn: () => {} }).records : wave([stamped]).map(({ reportId, ...r }) => r);
      assert.deepEqual(shape(later(second, logged, firstReport ? [firstReport] : [])), want);
    });
  }

  // A marker holds only the stamped death of the run its restart followed: the config's latest report to start before it.
  for (const [name, earlier, want] of [
    // The stamped run's relaunch wrote no marker (a failed write, no deathStore, or a pre-#315 engine), and died in turn.
    ['a first marker after a later relaunch of the stamped config is a new death',
      [at([stamped]), { configName: 'ship-dag-sd-1', startedAt: '2026-10-08T19:45:00Z', finishedAt: '2026-10-08T19:50:00Z', issues: [] }],
      [DEATH(B), [R2_TS, 'pushed', 'merged', null, 11]]],
    // A report rebuilt by hand after the relaunch, whose finishedAt is the rebuild time: its run started before the marker.
    ['a stamped report rebuilt after its relaunch is still the marker\'s death',
      [{ ...at([stamped]), startedAt: '2026-10-08T19:00:00Z', finishedAt: '2026-10-08T20:30:00Z' }],
      [[R2_TS, 'pushed', 'merged', null, 11]]],
  ]) {
    test(`engineDeaths: relaunch: ${name}`, () => {
      const logged = earlier.flatMap((r, i) => deriveWaveRecords(r, { runId: RUN, issues: [] }, {}, {}, {}, { reportId: `s${i}`, warn: () => {} }).records);
      assert.deepEqual(shape(later([{ ...merged, ...died(B) }], logged, earlier)), want);
    });
  }

  // A report as the ingest hands it to another's `earlier` or `later`: tagged with its id (`earlierReports`).
  const tagged = (report, reportId) => ({ ...report, reportId });
  const ingestAs = (report, existing, { earlier = [], later: after = [] } = {}) => deriveWaveRecords(report, { runId: RUN, issues: [] }, {}, {}, {}, { existing, reportId: report.reportId, earlier, later: after, warn: () => {} }).records;
  const diedAtOf = (records) => records.filter((r) => r.failureReason === 'engine-died').map((r) => r.ts);

  // The stamped report R1 and its relaunch R2, whose row lists R1's death as a marker: one death record, whichever is ingested first.
  const R1_START = '2026-10-08T16:00:00Z';
  for (const [name, r1Row, r2Row, want] of [
    ['a stamped death and the marker that lists it', stamped, { ...merged, ...died(B) }, 1],
    ['a stamped death that lists an earlier one: both deaths, each once', { ...stamped, ...died(D1) }, { ...merged, ...died(D1, B) }, 2],
    ['a marker that is not the stamped run\'s death stays a death', { ...merged, ...died(D1) }, { ...failedRow, ...died(D1, B) }, 2],
    // A stamped row that kept a PR is gated: its report derives no death of its own, so the marker records it, not defers to it.
    ['a stamped row that kept a PR: the marker is the death', { ...stamped, prNumber: 12 }, { ...merged, ...died(B) }, 1],
  ]) {
    const r1 = tagged(at([r1Row]), 'w1');
    const r2 = tagged({ ...at([r2Row]), finishedAt: R2_TS }, 'w2');
    test(`engineDeaths: ingest order: ${name}`, () => {
      const r1First = ingestAs(r1, [], { later: [r2] });
      assert.equal(diedAtOf([...r1First, ...ingestAs(r2, r1First, { earlier: [r1] })]).length, want, 'R1 first');
      const r2First = ingestAs(r2, [], { earlier: [r1] });
      assert.equal(diedAtOf([...r2First, ...ingestAs(r1, r2First, { later: [r2] })]).length, want, 'R2 first');
    });
  }

  // A log appended before a marker deferred to its stamped run already holds the marker's death: the stamped run adds no second one.
  test('engineDeaths: ingest order: a marker death already in the log holds the stamped run\'s own', () => {
    const r1 = tagged(at([stamped]), 'w1');
    const r2 = tagged({ ...at([{ ...merged, ...died(B) }]), finishedAt: R2_TS }, 'w2');
    const logged = [{ ...wave([stamped], [], 'w2')[0], ts: B }];
    assert.deepEqual(diedAtOf(ingestAs(r1, logged, { later: [r2] })), []);
  });

  // Audit agrees: the marker death that holds the stamped run's own death covers its row, and only beside the report that listed it.
  test('engineDeaths: rowCovered takes a marker death already in the log for the stamped row it holds', () => {
    const r1 = tagged(at([stamped]), 'w1');
    const r2 = tagged({ ...at([{ ...merged, ...died(B) }]), finishedAt: R2_TS }, 'w2');
    const logged = [{ ...wave([stamped], [], 'w2')[0], ts: B }];
    const covers = (records, later) => rowCovered(stamped, { id: 'w1', startedAt: 0, report: r1 }, records, RUN, undefined, [], later);
    assert.deepEqual([covers(logged, [r2]), covers(logged, []), covers([], [r2])], [true, false, false]);
  });

  // The deferral to the stamped run, not legacyDeath, is what holds a legacy model-error record (pre-#286): whatever legacy-shaped
  // record the log holds, a marker after a stamped run records nothing, and that run's ingest records its own death once. A
  // model error of a run that was not stamped is no death, so the marker records it.
  const R1_TS = '2026-10-08T19:30:00Z';
  const legacy = (records) => records.map((r) => ({ ...r, failureReason: null, finalState: 'error' }));
  for (const [name, r1Row, logged, want] of [
    ['the legacy record of the stamped run', stamped, legacy(wave([stamped])), [R1_TS]],
    ['a model error of a run that was not stamped', failedRow, wave([failedRow]), [B]],
    ['a legacy-shaped record of another report', stamped, legacy(wave([stamped], [], 'w0')), [R1_TS]],
    ['a hand-written model error, with no report to prove it', stamped, legacy(wave([stamped]).map(({ reportId, ...r }) => r)), [R1_TS]],
  ]) {
    test(`engineDeaths: legacy: ${name}`, () => {
      const r1 = tagged(at([r1Row]), 'w1');
      const r2 = tagged({ ...at([{ ...merged, ...died(B) }]), finishedAt: R2_TS }, 'w2');
      const r2Records = ingestAs(r2, logged, { earlier: [r1] });
      const r1Records = ingestAs(r1, [...logged, ...r2Records], { later: [r2] });
      assert.deepEqual(diedAtOf([...r2Records, ...r1Records]), want);
    });
  }

  // The relaunch of a stamped run died without writing a report; the report after it lists both deaths. Only the first is the stamped run's.
  test('engineDeaths: a relaunch that wrote no report: its death is a new one, since the stamped run started before the marker before it', () => {
    const r1 = tagged({ ...at([stamped]), startedAt: R1_START, finishedAt: '2026-10-08T16:30:00Z' }, 'w1');
    assert.deepEqual(diedAtOf(ingestAs(tagged({ ...at([{ ...merged, ...died(D1, D2) }]), finishedAt: R2_TS }, 'w2'), ingestAs(r1, []), { earlier: [r1] })), [D2]);
  });

  test('engineDeaths: markers are read oldest first whatever their order', () => {
    // Two stamped reports, each the run that died before one of the markers.
    const reports = ['2026-10-08T16:00:00Z', '2026-10-08T18:30:00Z'].map((finishedAt) => ({ ...at([stamped]), finishedAt }));
    const logged = reports.flatMap((r, i) => deriveWaveRecords(r, { runId: RUN, issues: [] }, {}, {}, {}, { reportId: `s${i}`, warn: () => {} }).records);
    assert.deepEqual(shape(later([{ ...merged, ...died(B, D1) }], logged, reports)), [[R2_TS, 'pushed', 'merged', null, 11]]);
  });

  test('engineDeaths: a carried-over row still records a new death its marker lists', () => {
    const skipped = { ref: 'a/b#1', status: 'skipped', prNumber: null };
    const earlier = [at([{ ...skipped, ran: false }])];
    const logged = wave([{ ...skipped, ran: false }]);
    assert.deepEqual(shape(later([{ ...skipped, ran: false, ...died(B) }], logged, earlier)), [DEATH(B)]);
  });

  test('engineDeaths: rowCovered does not take a marker\'s death for a stamped row\'s own', () => {
    const row = { ...stamped, ...died(D1) };
    const [markerDeath, own] = wave([row]);
    assert.equal(rowCovered(row, { id: 'w1', startedAt: 0 }, [markerDeath], RUN, undefined), false);
    assert.equal(rowCovered(row, { id: 'w1', startedAt: 0 }, [markerDeath, own], RUN, undefined), true);
  });

  test('engineDeaths: a death re-listed after a re-ingest of its stamped report is recorded once', () => {
    const logged = wave([stamped]);
    const reIngested = [...logged, ...wave([{ ...stamped, ...died(D1) }], logged)];
    assert.deepEqual(shape(later([{ ...merged, ...died(D1, B) }], reIngested, [at([stamped])])), [[R2_TS, 'pushed', 'merged', null, 11]]);
  });

  test('engineDeaths: a stamped row keeps its own outcome fields beside its earlier deaths', () => {
    const { records } = deriveWaveRecords(at([{ ...stamped, ...died(D1) }]), { runId: RUN, issues: [] }, {}, {}, { 'a/b#1': { pressureOverride: true, tokens: 7 } }, { reportId: 'w1', warn: () => {} });
    assert.deepEqual(records.map((r) => [r.ts, r.pressureOverride ?? false, r.tokens]), [[D1, false, null], [REPORT_TS, true, 7]]);
  });

  test('engineDeaths: a death derived earlier from the same report does not cover a later one', () => {
    const logged = wave([{ ...stamped, ...died(D1) }]);
    assert.deepEqual(shape(wave([{ ...stamped, ...died(D1, D2) }], logged)), [DEATH(D2)]);
  });

  test('engineDeaths: a death entry without a readable at is warned about and skipped', () => {
    const warned = [];
    const records = wave([{ ...merged, engineDeaths: [{ at: 'soon' }, {}, { at: D1 }] }], [], 'w1', (m) => warned.push(m));
    assert.deepEqual(shape(records), [DEATH(D1), [REPORT_TS, 'pushed', 'merged', null, 11]]);
    assert.equal(warned.length, 2);
  });

  test('ran: a derived record carries the row\'s ran, and a row with none carries none', () => {
    const [own] = deriveWaveRecords(at([ranFalse(setUp)]), { runId: RUN, issues: [] }, {}, {}, {}, { reportId: 'w1', warn: () => {} }).records;
    assert.deepEqual([own.ran, own.reportId], [false, 'w1']);
    const [legacy] = deriveWaveRecords(at([merged]), { runId: RUN, issues: [] }, {}, {}, {}, { reportId: 'w1', warn: () => {} }).records;
    assert.equal('ran' in legacy, false);
  });

  // A row a later report only carries over derives no record, whatever the log holds, so ingesting the later report first
  // leaves the earlier one's event for its own ingest. Only a row that says ran false is carried over; the rest derive their own.
  for (const [name, row, first, derived] of [
    ['a carried-over merge', ranFalse(merged), ranTrue(merged), 0],
    ['a carried-over skipped row', ranFalse(skipped), ranFalse(skipped), 0],
    ['a ran-false row whose earlier report lists another status', ranFalse(skipped), ranTrue(setUp), 1],
    ['a ran-false row whose earlier report lists another PR', ranFalse({ ...merged, prNumber: 12 }), ranTrue(merged), 1],
    ['a repeated worktree-setup failure', ranFalse(setUp), ranFalse(setUp), 1],
    ['a merge that ran again', ranTrue(merged), ranTrue(merged), 1],
    ['a row with no ran', merged, merged, 1],
  ]) {
    test(`ran: ${name}${derived ? ' is recorded' : ' derives no record'}, with no earlier record logged`, () => {
      const { records } = deriveWaveRecords(at([row]), { runId: RUN, issues: [] }, {}, {}, {}, { reportId: 'w2', earlier: [at([first])], warn: () => {} });
      assert.deepEqual(records.map((r) => r.reportId), derived ? ['w2'] : []);
      assert.equal(carriedOver(row, [at([first])]), !derived);
      assert.equal(carriedOver(row, []), false);
    });
  }

  test('carriedOver: a blocked row is carried over like a merge, since no retry re-runs it; a failed row is not', () => {
    const blocked = { ref: 'a/b#1', status: 'blocked', prNumber: null, ran: false };
    assert.equal(carriedOver(blocked, [at([blocked])]), true);
    assert.equal(carriedOver({ ...blocked, status: 'failed' }, [at([{ ...blocked, status: 'failed' }])]), false);
  });

  // Rows that kill M30 (a failed row with a PR read as a death, so never carried) and M31 (a pending launch stop read as never carried).
  for (const [name, row] of [
    ['a failed row with a PR the gate reviews', { ref: 'a/b#1', status: 'failed', prNumber: 11, ran: false }],
    ['a pending launch stop', { ref: 'a/b#1', status: 'pending', prNumber: null, ran: false }],
  ]) {
    test(`carriedOver: ${name} is carried over by an earlier report that lists it alike, not by one that lists another PR`, () => {
      assert.equal(carriedOver(row, [at([row])]), true);
      assert.equal(carriedOver(row, [at([{ ...row, prNumber: 12 }])]), false);
    });
  }

  // The readers of a row's ran take a boolean as the fact and anything else as absent, so a malformed report reads as one from before ran.
  for (const bad of ['false', 'true', 0, 1, null, {}, []]) {
    test(`ran: ${JSON.stringify(bad)} is no fact: the row is recorded as one with no ran, and ingest and audit fold it alike`, () => {
      const row = { ...merged, ran: bad };
      const legacy = deriveWaveRecords(at([merged]), { runId: RUN, issues: [] }, {}, {}, {}, { reportId: 'w1', warn: () => {} }).records;
      const earlier = [at([merged])];
      assert.equal(carriedOver({ ...skipped, ran: bad }, [at([skipped])]), false);
      const [alone] = deriveWaveRecords(at([row]), { runId: RUN, issues: [] }, {}, {}, {}, { reportId: 'w2', earlier, warn: () => {} }).records;
      assert.deepEqual(['ran' in alone, alone.reportId], [false, 'w2']);
      const { records } = deriveWaveRecords(at([row]), { runId: RUN, issues: [] }, {}, {}, {}, { existing: legacy, reportId: 'w2', earlier, warn: () => {} });
      assert.equal(records.length, 0);
      assert.equal(rowCovered(row, R2, legacy, RUN, undefined, earlier), true);
    });
  }

  // The record-level identity: two derived records of different reports are two events once either carries ran.
  const rec = (over = {}) => ({ runId: RUN, repo: 'a/b', issue: 1, implStatus: 'pushed', finalState: 'merged', pr: 11, ...over });
  for (const [name, a, b, same] of [
    ['two merges of different PRs, the later ran', rec({ reportId: 'w1' }), rec({ pr: 12, reportId: 'w2', ran: true }), false],
    ['two merges of different PRs, neither with ran', rec({ reportId: 'w1' }), rec({ pr: 12, reportId: 'w2' }), true],
    ['pushed and error, the later ran', rec({ reportId: 'w1' }), rec({ implStatus: 'error', reportId: 'w2', ran: true }), false],
    ['pushed and error, neither with ran', rec({ reportId: 'w1' }), rec({ implStatus: 'error', reportId: 'w2' }), true],
    ['the same report\'s two records', rec({ reportId: 'w1', ran: true }), rec({ reportId: 'w1', ran: true }), true],
    ['a hand-written record and one with ran', rec(), rec({ reportId: 'w2', ran: true }), true],
    ['a carried-over record (no reportId) and the earlier one', rec({ reportId: 'w1', ran: true }), rec({ ran: false }), true],
    // A death and its continuation (no reason) are two events: the continuation carries the outcome and its point-B mark.
    ['an engine death and the same report\'s deferred continuation', rec({ implStatus: 'error', finalState: 'deferred', reportId: 'w1' }), rec({ implStatus: 'error', finalState: 'deferred', failureReason: 'engine-died', reportId: 'w1' }), false],
    ['a rate-limit death and the same report\'s error with no reason', rec({ implStatus: 'error', finalState: 'deferred', reportId: 'w1' }), rec({ implStatus: 'error', finalState: 'deferred', failureReason: 'rate-limited', reportId: 'w1' }), false],
  ]) {
    test(`ran: sameEvent: ${name} ${same ? 'are' : 'are not'} one event`, () => {
      assert.equal(sameEvent(a, b), same);
      assert.equal(sameEvent(b, a), same);
    });
  }
}
