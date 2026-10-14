// Tests for deriving a ticket's stage from the files the engine and the review
// gate already write. Each case builds a throwaway run family with just the
// files that case needs, through the shared engine fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStage, readFamily } from './stage.mjs';
import { artifactStem } from '../lib/failure.mjs';
import { EMITTED, RUN, T0, engineFixture, stamped, stateReport, stateRow } from '../lib/engine-fixture.mjs';
import { DEFAULT_BLOCK_ON } from '../review-gate.mjs';

const REF = 'o/r#12';
const STEM = artifactStem(REF);
const WAVE_TS = Date.parse(EMITTED); // the wave's config was emitted just before its run started at T0
const EARLIER = '2026-10-08T17:00:00.000Z'; // a run of an earlier wave
const LATER = '2026-10-08T21:00:00.000Z'; // a retry's run, after the wave's run finished at T1
const finding = (category, extra = {}) => ({ category, verdict: 'CONFIRMED', blocking: true, file: 'a.ts', line: 1, summary: 's', failure_scenario: 'f', ...extra });
/** A review round; `reportId` stamps it the way step 4d does. */
const round = (findings, reportId) => ({ issue: 12, ...(reportId && { meta: { trigger: 'initial', reportId } }), findings });
const BLOCKING = round([finding('correctness')]);
const CLEAN = round([]);
/** A wave report that started at `startedAt` and lists REF, with `row` overriding its row. */
const report = (startedAt, row = {}) => stateReport([stateRow(REF, row)], { startedAt });
const PR = { prNumber: 99 };

const fixtures = [];
test.after(() => fixtures.forEach((fx) => fx.cleanup()));

/**
 * A run family under one base dir, `specs` mapping each dir's name to what it holds: REF's `status` (written at T0,
 * when the wave's run started the ticket, unless `stamped`) and `metadata`,
 * `reports` (file name → report) and `rounds` (file name under `reviews/`, `STEM` standing for REF's stem → contents,
 * a string written as is, `stamped` to pin its mtime). Returns each dir's path by name.
 */
function family(specs) {
  const fx = engineFixture(Object.fromEntries(Object.entries(specs).map(([name, { status, metadata, reports = {}, rounds = {} }]) => [name, {
    reports,
    files: {
      ...(status && { [`state/status/issue-${STEM}.status`]: typeof status === 'string' ? stamped(T0, status) : status }),
      ...(metadata && { [`state/metadata/issue-${STEM}.json`]: metadata }),
      ...Object.fromEntries(Object.entries(rounds).map(([n, body]) => [`reviews/${n.replaceAll('STEM', STEM)}`, body])),
    },
  }])));
  fixtures.push(fx);
  return fx.dirs;
}

/** REF's stage, its latest wave in `dir` (RUN's unless given) and the family read from there. */
const derive = (dirs, { dir = dirs[RUN], ...over } = {}) => deriveStage({
  dir, ref: REF, waveTs: WAVE_TS, family: readFamily(dir, { warn: () => {} }), blockOn: DEFAULT_BLOCK_ON, prOpen: true, ...over,
});

for (const [name, files, over, want] of [
  ['running with no report is Building', { status: 'running' }, {}, 'Building'],
  ['running owned by a report that started after the wave is a dead session: Stalled', { status: 'running', reports: { 'R1.json': report(T0) } }, {}, 'Stalled'],
  ['running owned only by an earlier wave\'s report is still Building', { status: 'running', reports: { 'R1.json': report(EARLIER) } }, {}, 'Building'],
  ['failed with no PR is Stalled', { status: 'failed', metadata: {} }, { prOpen: false }, 'Stalled'],
  ['interrupted with no PR is Stalled', { status: 'interrupted' }, { prOpen: false }, 'Stalled'],
  ['failed with a PR is review work, not a stall: In review', { status: 'failed', metadata: PR }, {}, 'In review'],
  ['an open PR with no review file is In review', { status: 'succeeded', metadata: PR }, {}, 'In review'],
  ['a blocking review is Fixing', { status: 'succeeded', metadata: PR, rounds: { 'STEM.json': BLOCKING } }, {}, 'Fixing'],
  ['a review with only nits is Reviewed, never "ready to merge"',
    { status: 'succeeded', metadata: PR, rounds: { 'STEM.json': round([finding('simplification', { blocking: false })]) } }, {}, 'Reviewed'],
  ['an empty review beside a .raw sibling is the #2587 signature: Review unreadable',
    { status: 'succeeded', metadata: PR, rounds: { 'STEM.json': CLEAN, 'STEM.json.raw': 'four findings' } }, {}, 'Review unreadable'],
  ['an unparseable review is Review unreadable', { status: 'succeeded', metadata: PR, rounds: { 'STEM.json': '{"findings": [' } }, {}, 'Review unreadable'],
  ['a review with no findings array is Review unreadable', { status: 'succeeded', metadata: PR, rounds: { 'STEM.json': { issue: 12 } } }, {}, 'Review unreadable'],
  ['the newest round wins: a blocking round, then a clean .r2', { status: 'succeeded', metadata: PR, rounds: { 'STEM.json': BLOCKING, 'STEM.r2.json': CLEAN } }, {}, 'Reviewed'],
  ['a legacy -rN round file counts as a round', { status: 'succeeded', metadata: PR, rounds: { 'STEM.json': CLEAN, 'STEM-r2.json': BLOCKING } }, {}, 'Fixing'],
  ['the round number, not the mtime, says which round is newest',
    { status: 'succeeded', metadata: PR, rounds: { 'STEM.json': stamped(T0, CLEAN), 'STEM.r2.json': stamped(EARLIER, BLOCKING) } }, {}, 'Fixing'],
  ["#123's review is never read as #12's", { status: 'succeeded', metadata: PR, rounds: { 'o%2Fr%23123.json': BLOCKING } }, {}, 'In review'],
  ['a per-pass file under reviews/passes/ is never scored', { status: 'succeeded', metadata: PR, rounds: { 'passes/STEM.1.verify.json': BLOCKING } }, {}, 'In review'],
  ['the run\'s --block-on decides: contract does not block when only correctness does',
    { status: 'succeeded', metadata: PR, rounds: { 'STEM.json': round([finding('contract')]) } }, { blockOn: ['correctness'] }, 'Reviewed'],
  ['no engine state and no open PR derives nothing', {}, { prOpen: false }, null],
  // A round stamped with a report id (`meta.reportId`) reviews that report's PR for the ref.
  ['a round stamped with the report that owns the ref is scored',
    { status: 'succeeded', metadata: PR, reports: { 'R1.json': report(T0, PR) }, rounds: { 'STEM.json': round([finding('correctness')], 'R1') } }, {}, 'Fixing'],
  ['a round stamped with an earlier report whose event a later one re-ran reviews the old PR: In review',
    { status: 'succeeded', metadata: PR, reports: { 'R1.json': report(EARLIER, { status: 'failed', prNumber: 50 }), 'R2.json': report(T0, PR) },
      rounds: { 'STEM.json': round([finding('correctness')], 'R1') } }, {}, 'In review'],
  // A point-E continuation's or a resource resume's rounds are stamped with the death report, which had no PR,
  // even when a later report owns the ref: they review the continuation's PR, the ticket's current one.
  ['a round stamped with an earlier report whose row has no PR reviews the current PR: Fixing',
    { status: 'succeeded', metadata: PR, reports: { 'R1.json': report(EARLIER, { status: 'failed', prNumber: null, prUrl: null }), 'R2.json': report(T0, PR) },
      rounds: { 'STEM.json': round([finding('correctness')], 'R1') } }, {}, 'Fixing'],
  ['a round stamped with no report of the run is read as an unstamped one',
    { status: 'succeeded', metadata: PR, reports: { 'R1.json': report(T0, PR) }, rounds: { 'STEM.json': round([finding('correctness')], 'no-such-report') } }, {}, 'Fixing'],
]) {
  test(`deriveStage: ${name}`, () => {
    assert.equal(derive(family({ [RUN]: files }), over), want);
  });
}

// The run family is main's (`runFamilyStateDirs`): a `-b` retry dir folds in, a `-board` dir does not.
for (const [name, sibling, startedAt, want] of [
  ['running owned by a report in a sibling retry dir that started after the wave: Stalled', `${RUN}-b`, T0, 'Stalled'],
  ['running owned by a report in a sibling retry dir from an earlier wave: Building', `${RUN}-b`, EARLIER, 'Building'],
  ['a report in a -board dir is no report of the run: Building', `${RUN}-board`, T0, 'Building'],
]) {
  test(`deriveStage: ${name}`, () => {
    assert.equal(derive(family({ [RUN]: { status: 'running' }, [sibling]: { reports: { 'R1.json': report(startedAt) } } })), want);
  });
}

test('deriveStage scores a round in the base dir stamped with the owner in the wave\'s sibling dir, and never a -board dir\'s', () => {
  const dirs = family({
    [RUN]: { rounds: { 'STEM.json': round([finding('correctness')], 'R2') } },
    [`${RUN}-w2`]: { status: 'succeeded', metadata: PR, reports: { 'R2.json': report(T0, PR) } },
    [`${RUN}-board`]: { rounds: { 'STEM.r2.json': CLEAN } },
  });
  assert.equal(derive(dirs, { dir: dirs[`${RUN}-w2`] }), 'Fixing');
});
