// Tests for the engine-artifact → telemetry-record derivation.
// Run: node --test 'scripts/**/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mintRunId,
  runIdFromConfigName,
  canonicalRunId,
  parseRef,
  normalizeOutcomes,
  deriveWaveRecords,
  deferredRecords,
  waveSidecar,
} from './wave-records.mjs';

// A minimal engine report, the shape claude-orchestrator writes to
// <stateDir>/state/reports/<ISO>.json.
function report(over = {}) {
  return {
    configName: 'ship-dag-sd-20260829-120000',
    startedAt: '2026-08-29T19:00:00.000Z',
    finishedAt: '2026-08-29T19:30:00.000Z',
    issues: [
      { ref: 'WXYC/dj-site#1', number: 1, status: 'succeeded', prUrl: 'https://x/1', prNumber: 11 },
      { ref: 'WXYC/dj-site#2', number: 2, status: 'succeeded', prUrl: 'https://x/2', prNumber: 12 },
    ],
    ...over,
  };
}

// The engine config emit-config.mjs wrote next to it, at <stateDir>/config.json.
function config(over = {}) {
  return {
    name: 'ship-dag-sd-20260829-120000',
    defaultModel: 'sonnet',
    defaultRepo: 'WXYC/dj-site',
    issues: [
      { number: 1, repo: 'WXYC/dj-site', complexity: 'mechanical' },
      { number: 2, repo: 'WXYC/dj-site', complexity: 'complex', model: 'opus' },
    ],
    ...over,
  };
}

test('mintRunId: sd-<YYYYMMDD>-<HHMMSS> in local time, optional slugged label', () => {
  const now = new Date(2026, 7, 31, 16, 21, 48); // local, so the test is TZ-independent
  assert.equal(mintRunId({ now }), 'sd-20260831-162148');
  assert.equal(mintRunId({ now, label: 'dj ios 135' }), 'sd-20260831-162148-dj-ios-135');
  assert.equal(mintRunId({ now, label: '!!!' }), 'sd-20260831-162148');
  assert.equal(mintRunId({ now: new Date(2026, 0, 2, 3, 4, 5) }), 'sd-20260102-030405');
});

test('runIdFromConfigName: strips the ship-dag- prefix, tolerates a bare name', () => {
  assert.equal(runIdFromConfigName('ship-dag-w4'), 'w4');
  assert.equal(runIdFromConfigName('ship-dag-sd-20260829-120000'), 'sd-20260829-120000');
  assert.equal(runIdFromConfigName('w4'), 'w4');
  assert.equal(runIdFromConfigName(undefined), null);
});

test('parseRef: splits a composite ref; rejects a bare number', () => {
  assert.deepEqual(parseRef('WXYC/dj-site#1207'), { repo: 'WXYC/dj-site', issue: 1207 });
  assert.equal(parseRef('1207'), null);
  assert.equal(parseRef(undefined), null);
});

test('normalizeOutcomes: accepts an array, a ref-keyed object, and the bare-string shorthand', () => {
  const arr = normalizeOutcomes([{ ref: 'o/r#1', finalState: 'merged' }]);
  assert.deepEqual(arr.get('o/r#1'), { finalState: 'merged' });
  const obj = normalizeOutcomes({ 'o/r#1': { finalState: 'merged', reviewVerdict: 'clean' } });
  assert.deepEqual(obj.get('o/r#1'), { finalState: 'merged', reviewVerdict: 'clean' });
  const short = normalizeOutcomes({ 'o/r#1': 'merged' });
  assert.deepEqual(short.get('o/r#1'), { finalState: 'merged' });
  assert.equal(normalizeOutcomes(undefined).size, 0);
});

test('deriveWaveRecords: derives everything the engine artifacts already know', () => {
  const { records, missing, unknown } = deriveWaveRecords({
    report: report(),
    config: config(),
    outcomes: { 'WXYC/dj-site#1': 'merged', 'WXYC/dj-site#2': { finalState: 'merged', reviewVerdict: 'blocking', bounces: 1 } },
  });
  assert.deepEqual(missing, []);
  assert.deepEqual(unknown, []);
  assert.equal(records.length, 2);
  const [a, b] = records;
  assert.equal(a.runId, 'sd-20260829-120000');
  assert.equal(a.repo, 'WXYC/dj-site');
  assert.equal(a.issue, 1);
  assert.equal(a.complexity, 'mechanical');
  assert.equal(a.triageStatus, 'clear');   // only cleared issues enter an engine config
  assert.equal(a.path, 'engine');
  assert.equal(a.assignment, 'sonnet');    // config defaultModel
  assert.equal(a.implStatus, 'pushed');
  assert.equal(a.ciStatus, 'pass');        // succeeded ⇒ the engine ran CI green pre-PR
  assert.equal(a.pr, 11);
  assert.equal(a.finalState, 'merged');
  assert.equal(a.ts, '2026-08-29T19:30:00.000Z'); // the engine's own clock, so a backfill lands in the past
  assert.equal(b.complexity, 'complex');
  assert.equal(b.assignment, 'opus');      // per-issue override beats defaultModel
  assert.equal(b.reviewVerdict, 'blocking');
  assert.equal(b.bounces, 1);
});

test('deriveWaveRecords: a failed row maps to error/fail and keeps its PR number', () => {
  const { records } = deriveWaveRecords({
    report: report({ issues: [{ ref: 'WXYC/dj-site#3', number: 3, status: 'failed', prNumber: 13 }] }),
    config: config({ issues: [{ number: 3, repo: 'WXYC/dj-site', complexity: 'normal' }] }),
    outcomes: { 'WXYC/dj-site#3': { finalState: 'blocked-hitl', hitl: { pointB: true } } },
  });
  assert.equal(records[0].implStatus, 'error');
  assert.equal(records[0].ciStatus, 'fail'); // a PR exists, so CI is what went red
  assert.equal(records[0].pr, 13);
  assert.equal(records[0].finalState, 'blocked-hitl');
  assert.equal(records[0].hitl.pointB, true);
});

test('deriveWaveRecords: a failed row with no PR never reached CI', () => {
  const { records } = deriveWaveRecords({
    report: report({ issues: [{ ref: 'WXYC/dj-site#4', number: 4, status: 'failed' }] }),
    config: config({ issues: [{ number: 4, repo: 'WXYC/dj-site' }] }),
    outcomes: { 'WXYC/dj-site#4': 'error' },
  });
  assert.equal(records[0].ciStatus, null);
  assert.equal(records[0].pr, null);
  assert.equal(records[0].complexity, 'normal'); // the engine's own default tier
});

test('deriveWaveRecords: a blocked row maps implStatus to blocked', () => {
  const { records } = deriveWaveRecords({
    report: report({ issues: [{ ref: 'WXYC/dj-site#5', number: 5, status: 'blocked' }] }),
    config: config({ issues: [{ number: 5, repo: 'WXYC/dj-site' }] }),
    outcomes: { 'WXYC/dj-site#5': 'blocked-hitl' },
  });
  assert.equal(records[0].implStatus, 'blocked');
});

test('deriveWaveRecords: an unsupplied outcome is named, not silently defaulted', () => {
  const { records, missing } = deriveWaveRecords({
    report: report(),
    config: config(),
    outcomes: { 'WXYC/dj-site#1': 'merged' },
  });
  // The under-emission defect in one line: the wave half-reported is refused,
  // not half-written, and the caller is told exactly which ref it forgot.
  assert.deepEqual(missing, ['WXYC/dj-site#2']);
  assert.equal(records.length, 1);
});

test('deriveWaveRecords: an outcome for a ref the report never mentions is reported as unknown', () => {
  const { unknown } = deriveWaveRecords({
    report: report(),
    config: config(),
    outcomes: { 'WXYC/dj-site#1': 'merged', 'WXYC/dj-site#2': 'merged', 'WXYC/dj-site#99': 'merged' },
  });
  assert.deepEqual(unknown, ['WXYC/dj-site#99']);
});

test('deriveWaveRecords: runId precedence — explicit, then config name, then report configName', () => {
  const pick = (over) => deriveWaveRecords({
    report: report(), config: config(), outcomes: { 'WXYC/dj-site#1': 'merged', 'WXYC/dj-site#2': 'merged' }, ...over,
  }).records[0].runId;
  assert.equal(pick({ runId: 'explicit' }), 'explicit');
  assert.equal(pick({ config: config({ name: 'ship-dag-from-config' }) }), 'from-config');
  assert.equal(pick({ config: null }), 'sd-20260829-120000');
});

test('deriveWaveRecords: no config at all still yields records off the report alone', () => {
  const { records, missing } = deriveWaveRecords({
    report: report(),
    config: null,
    outcomes: { 'WXYC/dj-site#1': 'merged', 'WXYC/dj-site#2': 'merged' },
  });
  assert.deepEqual(missing, []);
  assert.equal(records[0].repo, 'WXYC/dj-site');
  assert.equal(records[0].complexity, 'normal');
  assert.equal(records[0].assignment, null);
});

test('deriveWaveRecords: a rate-limited outcome round-trips failureReason', () => {
  const { records } = deriveWaveRecords({
    report: report({ issues: [{ ref: 'WXYC/dj-site#6', number: 6, status: 'failed' }] }),
    config: config({ issues: [{ number: 6, repo: 'WXYC/dj-site' }] }),
    outcomes: { 'WXYC/dj-site#6': { finalState: 'error', failureReason: 'rate-limited' } },
  });
  assert.equal(records[0].failureReason, 'rate-limited');
  assert.equal(records[0].implStatus, 'error');
});

test('deriveWaveRecords: an empty report yields nothing and complains about nothing', () => {
  const { records, missing, unknown } = deriveWaveRecords({ report: { issues: [] }, config: null });
  assert.deepEqual([records, missing, unknown], [[], [], []]);
});

test('deriveWaveRecords: a row with an unparseable ref falls back to number + the config default repo', () => {
  const { records } = deriveWaveRecords({
    report: report({ issues: [{ number: 7, status: 'succeeded', prNumber: 17 }] }),
    config: config({ issues: [{ number: 7, repo: 'WXYC/dj-site' }] }),
    outcomes: { 'WXYC/dj-site#7': 'merged' },
  });
  assert.equal(records[0].repo, 'WXYC/dj-site');
  assert.equal(records[0].issue, 7);
});

test('deferredRecords: one point-A record per triage deferral, off the spec the emitter already reads', () => {
  const recs = deferredRecords({
    runId: 'r1',
    repo: 'WXYC/dj-site',
    deferred: [
      { ref: 'WXYC/dj-site#8', complexity: 'complex' },
      { number: 9 },
    ],
  });
  assert.equal(recs.length, 2);
  assert.deepEqual(recs[0], {
    runId: 'r1', repo: 'WXYC/dj-site', issue: 8, complexity: 'complex', triageStatus: 'needs-decision',
    assignment: null, path: 'engine', implStatus: null, ciStatus: null, reviewVerdict: null,
    findings: [], bounces: 0, hitl: { pointA: true, pointB: false }, finalState: 'blocked-hitl', pr: null, tokens: null,
  });
  assert.equal(recs[1].issue, 9);
  assert.equal(recs[1].repo, 'WXYC/dj-site'); // spec default repo
  assert.equal(recs[1].complexity, 'normal');
});

test('deferredRecords: nothing deferred → no records', () => {
  assert.deepEqual(deferredRecords({ runId: 'r1', repo: 'o/r' }), []);
  assert.deepEqual(deferredRecords({ runId: 'r1', repo: 'o/r', deferred: [] }), []);
});

test('waveSidecar: carries the triage facts the report cannot, keyed by composite ref', () => {
  const side = waveSidecar({
    name: 'ship-dag-r1', wave: 3, repo: 'WXYC/dj-site',
    issues: [{ number: 1, repo: 'WXYC/dj-site', complexity: 'mechanical' }, { number: 2, model: 'opus' }],
    deferred: [{ ref: 'WXYC/dj-site#8' }],
  }, { now: () => '2026-08-31T00:00:00.000Z' });
  assert.equal(side.runId, 'r1');
  assert.equal(side.wave, 3);
  assert.equal(side.path, 'engine');
  assert.equal(side.emittedAt, '2026-08-31T00:00:00.000Z');
  assert.deepEqual(side.issues, [
    { ref: 'WXYC/dj-site#1', repo: 'WXYC/dj-site', number: 1, complexity: 'mechanical', assignment: null },
    { ref: 'WXYC/dj-site#2', repo: 'WXYC/dj-site', number: 2, complexity: null, assignment: 'opus' },
  ]);
  assert.deepEqual(side.deferred, ['WXYC/dj-site#8']);
});

test('waveSidecar: a sidecar reads back as a config for deriveWaveRecords', () => {
  // The sidecar is the preferred context source; it must satisfy the same
  // shape contract config.json does, or ingest silently loses complexity.
  const side = waveSidecar({
    name: 'ship-dag-r1', repo: 'WXYC/dj-site',
    issues: [{ number: 1, repo: 'WXYC/dj-site', complexity: 'complex', model: 'opus' }],
  }, { now: () => 'x' });
  const { records } = deriveWaveRecords({
    report: report({ issues: [{ ref: 'WXYC/dj-site#1', number: 1, status: 'succeeded', prNumber: 11 }] }),
    config: side,
    outcomes: { 'WXYC/dj-site#1': 'merged' },
  });
  assert.equal(records[0].complexity, 'complex');
  assert.equal(records[0].assignment, 'opus');
  assert.equal(records[0].runId, 'r1');
});

test('canonicalRunId: folds the ship-dag- prefix and the per-wave state-dir suffix', () => {
  assert.equal(canonicalRunId('ship-dag-sd-20260729-095805'), 'sd-20260729-095805');
  assert.equal(canonicalRunId('ship-dag-ship-dag-1819-20260728'), '1819-20260728');
  assert.equal(canonicalRunId('sd-20260729-095805-w3'), 'sd-20260729-095805');
  assert.equal(canonicalRunId('sd-20260729-095805-resume'), 'sd-20260729-095805');
  assert.equal(canonicalRunId('shipdag-1100-20260803-222046-w1b'), 'shipdag-1100-20260803-222046');
  assert.equal(canonicalRunId('sd-archive-player-20260829-1322-r2'), 'sd-archive-player-20260829-1322');
  // A meaningful trailing segment that isn't a wave suffix survives.
  assert.equal(canonicalRunId('sd-20260831-followups-a'), 'sd-20260831-followups-a');
  assert.equal(canonicalRunId('cap321-20260806-131523'), 'cap321-20260806-131523');
  assert.equal(canonicalRunId(undefined), null);
  assert.equal(canonicalRunId('  '), null);
});
