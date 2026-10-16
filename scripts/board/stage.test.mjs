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
  // An unstamped round (or one stamped with no report of the run) counts only from the owning report's startedAt.
  ['an unstamped round older than the owner\'s startedAt is ignored, so the newer .json decides',
    { status: 'succeeded', metadata: PR, reports: { 'R1.json': report(T0, PR) },
      rounds: { 'STEM.json': CLEAN, 'STEM.r3.json': stamped(EARLIER, BLOCKING) } }, {}, 'Reviewed'],
  ['an unstamped round older than the owner\'s startedAt alone leaves the ticket In review',
    { status: 'succeeded', metadata: PR, reports: { 'R1.json': report(T0, PR) }, rounds: { 'STEM.json': stamped(EARLIER, BLOCKING) } }, {}, 'In review'],
  ['a round stamped with no report of the run is windowed like an unstamped one',
    { status: 'succeeded', metadata: PR, reports: { 'R1.json': report(T0, PR) }, rounds: { 'STEM.json': stamped(EARLIER, round([finding('correctness')], 'no-such-report')) } }, {}, 'In review'],
  ['with no owning report every unstamped round counts',
    { status: 'succeeded', metadata: PR, rounds: { 'STEM.json': stamped(EARLIER, BLOCKING) } }, {}, 'Fixing'],
  // A dead ticket whose PR is no longer open is Stalled, whatever metadata.prNumber still says.
  ['failed with a PR that is no longer open is Stalled', { status: 'failed', metadata: PR }, { prOpen: false }, 'Stalled'],
  // The caller's open PR number stands in for a missing metadata.prNumber in routing a dead ticket, too.
  ['failed with an open PR and no metadata.prNumber, whose latest round blocks, is Fixing, not Stalled',
    { status: 'failed', rounds: { 'STEM.json': BLOCKING } }, { openPr: 99 }, 'Fixing'],
  ['interrupted with an open PR and no metadata.prNumber is In review, not Stalled', { status: 'interrupted' }, { openPr: 99 }, 'In review'],
  ['interrupted with a PR that is no longer open is Stalled', { status: 'interrupted', metadata: PR }, { prOpen: false }, 'Stalled'],
  // The open PR's number, when the caller has it, replaces metadata.prNumber in the stamped-round comparison.
  ['with no metadata.prNumber, a round stamped with a report whose row has the open PR counts',
    { status: 'succeeded', reports: { 'R1.json': report(T0, PR) }, rounds: { 'STEM.json': round([finding('correctness')], 'R1') } }, { openPr: 99 }, 'Fixing'],
  ['with no metadata.prNumber, a round stamped with a report whose row has another PR is skipped',
    { status: 'succeeded', reports: { 'R1.json': report(T0, { prNumber: 50 }) }, rounds: { 'STEM.json': round([finding('correctness')], 'R1') } }, { openPr: 99 }, 'In review'],
  ['the open PR\'s number wins over a stale metadata.prNumber',
    { status: 'succeeded', metadata: { prNumber: 50 }, reports: { 'R1.json': report(T0, PR) }, rounds: { 'STEM.json': round([finding('correctness')], 'R1') } }, { openPr: 99 }, 'Fixing'],
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

// A retry re-runs the ticket in a session that started after the wave's report finished: that report says nothing
// about the retry's session, whether the retry has its own -b dir or reran in place (--retry-failed).
for (const [name, specs, dirName] of [
  ['a fresh running ticket in a -b retry dir is Building, though an earlier report of the same wave owns it',
    { [RUN]: { reports: { 'R1.json': report(T0, { status: 'failed', prNumber: null }) } }, [`${RUN}-b`]: { status: stamped(LATER, 'running') } }, `${RUN}-b`],
  ['a ticket rerun in place is Building, though the report of its first run owns it',
    { [RUN]: { status: stamped(LATER, 'running'), reports: { 'R1.json': report(T0, { status: 'failed', prNumber: null }) } } }, RUN],
]) {
  test(`deriveStage: ${name}`, () => {
    const dirs = family(specs);
    assert.equal(derive(dirs, { dir: dirs[dirName] }), 'Building');
  });
}

// The engine writes metadata.startedAt at each launch, right after it writes `running`, so the session start is read
// from there; the status file's mtime is only a fallback, since a copy or restore that loses mtimes moves it.
const FAILED_FIRST = report(T0, { status: 'failed', prNumber: null }); // the wave's first run: T0 to T1
for (const [name, specs, dirName, want] of [
  ['a session that launched before the report finished is Stalled, though the status file\'s mtime is newer',
    { [RUN]: { status: stamped(LATER, 'running'), metadata: { startedAt: T0 }, reports: { 'R1.json': FAILED_FIRST } } }, RUN, 'Stalled'],
  ['a session that launched after the report finished is Building, though the status file\'s mtime is older',
    { [RUN]: { status: stamped(T0, 'running'), metadata: { startedAt: LATER }, reports: { 'R1.json': FAILED_FIRST } } }, RUN, 'Building'],
  ['a -b retry that launched after the wave\'s report finished is Building, whatever its mtime',
    { [RUN]: { reports: { 'R1.json': FAILED_FIRST } }, [`${RUN}-b`]: { status: stamped(T0, 'running'), metadata: { startedAt: LATER } } }, `${RUN}-b`, 'Building'],
  ['a -b retry that launched before the wave\'s report finished is Stalled, whatever its mtime',
    { [RUN]: { reports: { 'R1.json': FAILED_FIRST } }, [`${RUN}-b`]: { status: stamped(LATER, 'running'), metadata: { startedAt: T0 } } }, `${RUN}-b`, 'Stalled'],
  ['an unparseable metadata.startedAt falls back to the mtime',
    { [RUN]: { status: stamped(LATER, 'running'), metadata: { startedAt: 'soon' }, reports: { 'R1.json': FAILED_FIRST } } }, RUN, 'Building'],
  ['a report with no finishedAt is measured from its startedAt',
    { [RUN]: { status: stamped(T0, 'running'), metadata: { startedAt: LATER }, reports: { 'R1.json': { ...FAILED_FIRST, finishedAt: undefined } } } }, RUN, 'Building'],
]) {
  test(`deriveStage: ${name}`, () => {
    const dirs = family(specs);
    assert.equal(derive(dirs, { dir: dirs[dirName] }), want);
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

test('readFamily reads the dirs it is given instead of listing the family again', () => {
  const dirs = family({ [RUN]: { reports: { 'R1.json': report(T0) } }, [`${RUN}-b`]: {} });
  const only = [dirs[`${RUN}-b`]];
  const fam = readFamily(dirs[RUN], { warn: () => {}, dirs: only });
  assert.deepEqual(fam.dirs, only);
  assert.equal(fam.ownership.ownerOf(REF), null);
  assert.ok(readFamily(dirs[RUN], { warn: () => {} }).ownership.ownerOf(REF), 'listed, the family holds the report');
});
