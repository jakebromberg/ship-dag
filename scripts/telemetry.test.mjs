// Tests for the telemetry log + report. Run: node --test "skills/ship-dag/scripts/**/*.test.mjs"
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { rmSync, readFileSync, readdirSync, existsSync, appendFileSync, chmodSync, mkdirSync, renameSync } from 'node:fs';
import { WaveRefusal } from './lib/wave-records.mjs';
import { normalizeRecord, appendRecord, readRecords, report, renderReport, telemetryPath, ingestWave, audit } from './telemetry.mjs';
import { artifactStem } from './lib/failure.mjs';
import { NO_ENGINE_DIR } from './lib/tripwires.mjs';
import { load as loadTuning } from './lib/tuning.mjs';
import { engineFixture, stamped, putReview, putDigest, stateRow, stateReport, sidecarEntry, engineConfig as config, RUN, T0, T1, EMITTED } from './lib/engine-fixture.mjs';

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const FIXED = () => '2026-07-23T00:00:00.000Z';

let counter = 0;
const tmpLog = () => join(tmpdir(), `ship-dag-tel-${process.pid}-${counter++}.jsonl`);

// A complete, valid record; overrides tailor it per test.
function base(over = {}) {
  return {
    runId: 'r1', repo: 'WXYC/x', issue: 1, complexity: 'normal', triageStatus: 'clear',
    path: 'inline', finalState: 'merged', implStatus: 'pushed', ciStatus: 'pass',
    reviewVerdict: 'clean', bounces: 0, hitl: { pointA: false, pointB: false }, ...over,
  };
}

test('normalizeRecord: stamps ts when absent, keeps it when present', () => {
  assert.equal(normalizeRecord(base(), FIXED).ts, FIXED());
  assert.equal(normalizeRecord(base({ ts: '2020-01-01T00:00:00Z' }), FIXED).ts, '2020-01-01T00:00:00Z');
});

test('normalizeRecord: rejects bad enums and missing required keys', () => {
  assert.throws(() => normalizeRecord(base({ finalState: 'nope' }), FIXED), /bad finalState/);
  assert.throws(() => normalizeRecord(base({ complexity: 'huge' }), FIXED), /bad complexity/);
  assert.throws(() => normalizeRecord(base({ path: 'sideways' }), FIXED), /bad path/);
  // `engine` is the primary step-4 path (implement via the orchestrator); accepted alongside the two fallbacks.
  assert.equal(normalizeRecord(base({ path: 'engine' }), FIXED).path, 'engine');
  assert.throws(() => normalizeRecord(base({ runId: undefined }), FIXED), /missing required key: runId/);
  assert.throws(() => normalizeRecord('not an object', FIXED), /must be an object/);
});

test('normalizeRecord: accepts reportId and complexitySource, and a record without them stays valid', () => {
  const r = normalizeRecord(base({ reportId: 'w1', complexitySource: 'default' }), FIXED);
  assert.deepEqual([r.reportId, r.complexitySource], ['w1', 'default']);
  assert.doesNotThrow(() => normalizeRecord(base(), FIXED));
  assert.doesNotThrow(() => normalizeRecord(base({ reportId: null, complexitySource: null }), FIXED));
  assert.throws(() => normalizeRecord(base({ complexitySource: 'guess' }), FIXED), /bad complexitySource/);
  // reportId decides whether two PR-less failures are one event, so only a real stem is let in.
  for (const reportId of [7, '', ['w1']]) assert.throws(() => normalizeRecord(base({ reportId }), FIXED), /bad reportId/);
});

test('normalizeRecord: accepts a boolean ran, and a record without one stays valid', () => {
  for (const ran of [true, false]) assert.equal(normalizeRecord(base({ ran }), FIXED).ran, ran);
  assert.equal('ran' in normalizeRecord(base(), FIXED), false);
  // ran separates one report's own event from the earlier one it re-lists, so only a boolean is let in.
  for (const ran of ['false', 0, [], {}]) assert.throws(() => normalizeRecord(base({ ran }), FIXED), /bad ran/);
});

test('normalizeRecord: point-A defer record — nullable downstream fields default to null', () => {
  const r = normalizeRecord(
    { runId: 'r', repo: 'WXYC/x', issue: 2, complexity: 'complex', triageStatus: 'needs-decision', path: 'inline', finalState: 'blocked-hitl', hitl: { pointA: true } },
    FIXED,
  );
  assert.equal(r.implStatus, null);
  assert.equal(r.ciStatus, null);
  assert.equal(r.reviewVerdict, null);
  assert.equal(r.hitl.pointA, true);
  assert.equal(r.hitl.pointB, false);
  assert.deepEqual(r.findings, []);
  assert.equal(r.tokens, null);
});

test('normalizeRecord: failureReason defaults to null and round-trips "rate-limited" alongside implStatus "error"', () => {
  const withoutIt = normalizeRecord(base({ finalState: 'blocked-hitl', implStatus: 'error' }), FIXED);
  assert.equal(withoutIt.failureReason, null);
  const withIt = normalizeRecord(
    base({ finalState: 'blocked-hitl', implStatus: 'error', failureReason: 'rate-limited' }),
    FIXED,
  );
  assert.equal(withIt.implStatus, 'error');
  assert.equal(withIt.failureReason, 'rate-limited');
});

for (const failureReason of ['memory-critical', 'lease-wait']) {
  test(`normalizeRecord: round-trips "${failureReason}"`, () => {
    assert.equal(normalizeRecord(base({ finalState: 'deferred', implStatus: 'error', failureReason }), FIXED).failureReason, failureReason);
  });
}

test('normalizeRecord: rejects an unrecognized failureReason', () => {
  assert.throws(() => normalizeRecord(base({ failureReason: 'gremlins' }), FIXED), /bad failureReason/);
});

test('appendRecord: append-only, one line per call, creates the state dir', () => {
  const dir = join(tmpdir(), `ship-dag-tel-dir-${process.pid}-${counter++}`);
  const p = join(dir, 'runs.jsonl');
  try {
    assert.equal(existsSync(dir), false);
    appendRecord(base({ issue: 1 }), { path: p, now: FIXED });
    appendRecord(base({ issue: 2 }), { path: p, now: FIXED });
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).issue, 1);
    assert.equal(JSON.parse(lines[1]).issue, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readRecords: missing file → []', () => {
  assert.deepEqual(readRecords(join(tmpdir(), `ship-dag-nope-${process.pid}.jsonl`)), []);
});

test('telemetryPath: SHIP_DAG_TELEMETRY > XDG_STATE_HOME > HOME/.local/state', () => {
  assert.equal(telemetryPath({ SHIP_DAG_TELEMETRY: '/x/y.jsonl' }), '/x/y.jsonl');
  assert.equal(telemetryPath({ XDG_STATE_HOME: '/state' }), '/state/ship-dag/runs.jsonl');
  assert.equal(telemetryPath({ HOME: '/home/j' }), '/home/j/.local/state/ship-dag/runs.jsonl');
});

// The canonical 8-record indicator fixture, shared by the plain report test and
// the retro-exclusion regression test so the two can never silently measure
// different populations.
function fixture8() {
  return [
    base({ complexity: 'mechanical', bounces: 0, reviewVerdict: 'clean' }),                 // 1 mech pass
    base({ complexity: 'mechanical', bounces: 0, reviewVerdict: 'nits-only' }),             // 2 mech pass (nit ≠ miss)
    base({ complexity: 'normal', bounces: 1, reviewVerdict: 'blocking' }),                  // 3 normal bounced→merged, miss
    base({ complexity: 'normal', bounces: 0, reviewVerdict: 'clean' }),                     // 4 normal pass
    base({ complexity: 'complex', finalState: 'blocked-hitl', bounces: 2, reviewVerdict: 'blocking', hitl: { pointA: false, pointB: true } }), // 5 complex miss, B
    base({ complexity: 'complex', triageStatus: 'needs-decision', finalState: 'blocked-hitl', implStatus: null, ciStatus: null, reviewVerdict: null, hitl: { pointA: true, pointB: false } }), // 6 point-A defer
    base({ complexity: 'normal', finalState: 'blocked-hitl', implStatus: 'blocked', reviewVerdict: null, hitl: { pointA: false, pointB: true } }), // 7 impl bail, miss, B
    base({ complexity: 'mechanical', bounces: 0, reviewVerdict: 'clean' }),                 // 8 mech pass
  ];
}

test('report: leading indicators over an 8-record fixture', () => {
  const recs = fixture8().map((r) => normalizeRecord(r, FIXED));
  const rep = report(recs);

  assert.equal(rep.n, 8);
  assert.equal(rep.firstPassYield.reached, 7); // all but the point-A defer
  assert.equal(rep.firstPassYield.pass, 4);
  approx(rep.firstPassYield.rate, 4 / 7);
  assert.deepEqual(rep.byComplexity.mechanical, { reached: 3, pass: 3, rate: 1 });
  assert.equal(rep.byComplexity.normal.reached, 3);
  assert.equal(rep.byComplexity.normal.pass, 1);
  assert.deepEqual(rep.byComplexity.complex, { reached: 1, pass: 0, rate: 0 });
  assert.equal(rep.triageMiss.cleared, 7); // 8 minus the one needs-decision
  assert.equal(rep.triageMiss.miss, 3);    // #3 blocking, #5 blocking, #7 impl-blocked
  approx(rep.bounceRate, 3 / 7);
  assert.equal(rep.hitl.pointA.count, 1);
  assert.equal(rep.hitl.pointB.count, 2);
  assert.equal(rep.reviewCatch.blocking, 2);
  assert.equal(rep.reviewCatch.reached, 7);
});

test('report: a rate-limited death record followed by the same issue merging is excluded from model-quality indicators, tallied as a quota failure', () => {
  // The death record is real telemetry — emitted at death time, before the
  // wrapper resumes the issue in place — so both records land in the log for
  // the same repo#issue. It must not dilute first-pass yield: excluded from
  // `reached` even though implStatus: "error" is non-null.
  const recs = [
    normalizeRecord(base({ issue: 5, finalState: 'error', implStatus: 'error', failureReason: 'rate-limited', reviewVerdict: null, ciStatus: null }), FIXED),
    normalizeRecord(base({ issue: 5, finalState: 'merged', implStatus: 'pushed', reviewVerdict: 'clean', bounces: 0 }), FIXED),
  ];
  const rep = report(recs);
  assert.equal(rep.n, 2);
  assert.equal(rep.quotaFailures, 1);
  assert.equal(rep.firstPassYield.reached, 1);
  assert.equal(rep.firstPassYield.pass, 1);
  assert.equal(rep.firstPassYield.rate, 1);
  assert.equal(rep.triageMiss.cleared, 1);
  assert.equal(rep.reviewCatch.reached, 1);
});

// An engine stop (memory pressure, a lease wait) is infrastructure, not a model-quality signal, so it is left out of
// every indicator as rate-limited is, and tallied in `resourceStops` rather than `quotaFailures`.
for (const failureReason of ['memory-critical', 'lease-wait']) {
  test(`report: a ${failureReason} record is excluded from model-quality indicators and tallied as a resource stop`, () => {
    const recs = [
      normalizeRecord(base({ issue: 5, finalState: 'deferred', implStatus: 'error', failureReason, reviewVerdict: null, ciStatus: null }), FIXED),
      normalizeRecord(base({ issue: 6, finalState: 'deferred', implStatus: null, failureReason, reviewVerdict: null, ciStatus: null }), FIXED),
      normalizeRecord(base({ issue: 5, finalState: 'merged', implStatus: 'pushed', reviewVerdict: 'clean', bounces: 0 }), FIXED),
    ];
    const rep = report(recs);
    assert.deepEqual([rep.n, rep.quotaFailures, rep.resourceStops], [3, 0, 2]);
    assert.deepEqual([rep.firstPassYield.reached, rep.firstPassYield.pass, rep.triageMiss.cleared, rep.reviewCatch.reached], [1, 1, 1, 1]);
    assert.match(renderReport(rep), /resource stops:\s+2/);
  });
}

test('renderReport: a log with no resource stops has no "resource stops" line', () => {
  assert.ok(!/resource stops/.test(renderReport(report([normalizeRecord(base(), FIXED)]))));
});

test('renderReport: quota-failure-free log has no "quota failures" line', () => {
  const rep = report([normalizeRecord(base(), FIXED)]);
  assert.ok(!/quota failures/.test(renderReport(rep)));
});

test('renderReport: prints the quota-failures line when present', () => {
  const recs = [
    normalizeRecord(base({ issue: 5, finalState: 'error', implStatus: 'error', failureReason: 'rate-limited', reviewVerdict: null, ciStatus: null }), FIXED),
    normalizeRecord(base({ issue: 5, finalState: 'merged', implStatus: 'pushed', reviewVerdict: 'clean', bounces: 0 }), FIXED),
  ];
  const rendered = renderReport(report(recs));
  assert.ok(/^quota failures:\s+1$/m.test(rendered));
});

test('normalizeRecord: rejects bad triageStatus and ciStatus', () => {
  assert.throws(() => normalizeRecord(base({ triageStatus: 'cleared' }), FIXED), /bad triageStatus/);
  assert.throws(() => normalizeRecord(base({ ciStatus: 'green' }), FIXED), /bad ciStatus/);
});

test('readRecords: tolerates a malformed line, returns the valid records', () => {
  const dir = join(tmpdir(), `ship-dag-tel-bad-${process.pid}-${counter++}`);
  const p = join(dir, 'runs.jsonl');
  try {
    appendRecord(base({ issue: 1 }), { path: p, now: FIXED });
    appendFileSync(p, '{ this is not json\n');
    appendRecord(base({ issue: 2 }), { path: p, now: FIXED });
    const recs = readRecords(p);
    assert.deepEqual(recs.map((r) => r.issue), [1, 2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A complete, valid step-6.5 retrospective record; overrides tailor it per test.
function retroBase(over = {}) {
  return {
    kind: 'retro', runId: 'r1', wave: 2, mergedPrs: ['WXYC/x#41', 'WXYC/x#43'],
    proposedRefactors: 2, approvedRefactors: 1, declinedRefactors: 1,
    proposedAdjustments: 1, approvedAdjustments: 1, declinedAdjustments: 0,
    filed: ['WXYC/x#77'], adjusted: ['WXYC/x#55'], declinedTitles: ['dedupe retry helper'],
    ...over,
  };
}

test('normalizeRecord: retro record — stamps ts, keeps counts, defaults the rest', () => {
  const r = normalizeRecord(retroBase(), FIXED);
  assert.equal(r.ts, FIXED());
  assert.equal(r.kind, 'retro');
  assert.equal(r.proposedRefactors, 2);
  assert.deepEqual(r.filed, ['WXYC/x#77']);
  const minimal = normalizeRecord({ kind: 'retro', runId: 'r', wave: 1, mergedPrs: [] }, FIXED);
  assert.equal(minimal.proposedRefactors, 0);
  assert.equal(minimal.approvedRefactors, 0);
  assert.equal(minimal.declinedRefactors, 0);
  assert.equal(minimal.proposedAdjustments, 0);
  assert.equal(minimal.approvedAdjustments, 0);
  assert.equal(minimal.declinedAdjustments, 0);
  assert.deepEqual(minimal.filed, []);
  assert.deepEqual(minimal.adjusted, []);
  assert.deepEqual(minimal.declinedTitles, []);
  assert.equal(minimal.tokens, null);
});

test('normalizeRecord: retro records skip the issue coercions entirely', () => {
  // Guards against a future "unification" of the two paths: the issue-record hitl
  // coercion silently drops unknown keys, so routing a retro record through it
  // would mangle the record without any error.
  const r = normalizeRecord(retroBase(), FIXED);
  assert.ok(!('hitl' in r));
  assert.ok(!('implStatus' in r));
  assert.ok(!('ciStatus' in r));
  assert.ok(!('reviewVerdict' in r));
  assert.ok(!('failureReason' in r));
});

test('normalizeRecord: retro rejection — bad kind, missing keys, non-array mergedPrs', () => {
  assert.throws(() => normalizeRecord(base({ kind: 'sideways' }), FIXED), /bad kind/);
  assert.throws(() => normalizeRecord(retroBase({ wave: undefined }), FIXED), /missing required key: wave/);
  assert.throws(() => normalizeRecord(retroBase({ mergedPrs: undefined }), FIXED), /missing required key: mergedPrs/);
  assert.throws(() => normalizeRecord(retroBase({ mergedPrs: 'WXYC/x#41' }), FIXED), /mergedPrs must be an array/);
});

test('normalizeRecord: kind back-compat — absent kind is stamped "issue"', () => {
  assert.equal(normalizeRecord(base(), FIXED).kind, 'issue');
  assert.equal(normalizeRecord(base({ kind: 'issue' }), FIXED).kind, 'issue');
});

test('appendRecord: retro record round-trips through readRecords', () => {
  const dir = join(tmpdir(), `ship-dag-tel-retro-${process.pid}-${counter++}`);
  const p = join(dir, 'runs.jsonl');
  try {
    appendRecord(retroBase(), { path: p, now: FIXED });
    const recs = readRecords(p);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].kind, 'retro');
    assert.deepEqual(recs[0].mergedPrs, ['WXYC/x#41', 'WXYC/x#43']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('report: retro records are excluded from every per-issue indicator', () => {
  // The shared 8-record fixture plus one retro record — every per-issue value
  // must match the plain report test above. The explicit hitl.*.n assertions
  // pin the denominators that inflate if any of the six records→issues
  // substitutions inside report() is missed.
  const recs = fixture8().map((r) => normalizeRecord(r, FIXED));
  const rep = report([...recs, normalizeRecord(retroBase(), FIXED)]);

  assert.equal(rep.n, 8);
  assert.equal(rep.firstPassYield.reached, 7);
  assert.equal(rep.firstPassYield.pass, 4);
  assert.equal(rep.triageMiss.cleared, 7);
  assert.equal(rep.triageMiss.miss, 3);
  approx(rep.bounceRate, 3 / 7);
  assert.equal(rep.hitl.pointA.n, 8);
  assert.equal(rep.hitl.pointB.n, 8);
  assert.equal(rep.hitl.pointA.count, 1);
  assert.equal(rep.hitl.pointB.count, 2);
  assert.equal(rep.reviewCatch.reached, 7);
  assert.deepEqual(rep.retro, {
    passes: 1, mergedPrs: 2, proposed: 3, approved: 2, declined: 1, filed: 1, approvalRate: 2 / 3,
  });
});

test('renderReport: no retro lines on an issue-only log', () => {
  const rep = report([normalizeRecord(base(), FIXED)]);
  assert.ok(!/retro/.test(renderReport(rep)));
});

test('report: retro-only log — per-issue indicators zeroed, retro section rendered', () => {
  const rep = report([normalizeRecord(retroBase(), FIXED)]);
  assert.equal(rep.n, 0);
  assert.deepEqual(rep.firstPassYield, { reached: 0, pass: 0, rate: 0 });
  assert.equal(rep.retro.passes, 1);
  const rendered = renderReport(rep);
  // Anchored to full lines: an unanchored /tickets filed:\s+1/ would also
  // match "tickets filed:   11", hiding a count corrupted by concatenation.
  assert.ok(/^retro passes:\s+1 \(2 PRs\)$/m.test(rendered));
  assert.ok(/^ {2}proposals:\s+3 proposed, 2 approved, 1 declined \(66\.7% approved\)$/m.test(rendered));
  assert.ok(/^ {2}tickets filed:\s+1$/m.test(rendered));
});

test('normalizeRecord: retro rejection — non-numeric counts and non-array lists', () => {
  assert.throws(() => normalizeRecord(retroBase({ proposedRefactors: '2' }), FIXED), /proposedRefactors must be a number/);
  assert.throws(() => normalizeRecord(retroBase({ declinedAdjustments: NaN }), FIXED), /declinedAdjustments must be a number/);
  assert.throws(() => normalizeRecord(retroBase({ filed: 'WXYC/x#77' }), FIXED), /filed must be an array/);
  assert.throws(() => normalizeRecord(retroBase({ filed: 3 }), FIXED), /filed must be an array/);
  assert.throws(() => normalizeRecord(retroBase({ adjusted: 'WXYC/x#55' }), FIXED), /adjusted must be an array/);
  assert.throws(() => normalizeRecord(retroBase({ declinedTitles: 'dedupe' }), FIXED), /declinedTitles must be an array/);
});

test('normalizeRecord: retro-shaped record without kind gets a pointed error', () => {
  // Without the guard this would die on `missing required key: repo` — naming
  // the one field the retro schema deliberately excludes — and the best-effort
  // append rule would swallow it, silently losing the run ledger's only
  // durable record.
  assert.throws(() => normalizeRecord({ runId: 'r', wave: 1, mergedPrs: [] }, FIXED), /missing kind: "retro"/);
  assert.throws(() => normalizeRecord({ runId: 'r', mergedPrs: ['o/r#1'] }, FIXED), /missing kind: "retro"/);
});

test('report: raw readRecords output — a legacy kind-less line partitions as an issue record', () => {
  // Real logs predate the kind field and report() consumes readRecords output
  // un-normalized, so the partition must work on raw parsed lines.
  const p = tmpLog();
  const legacy = { ...base({ issue: 9 }), ts: FIXED() }; // a line written before the discriminator existed
  try {
    appendFileSync(p, `${JSON.stringify(legacy)}\n${JSON.stringify(retroBase({ ts: FIXED() }))}\n`);
    const rep = report(readRecords(p));
    assert.equal(rep.n, 1);
    assert.equal(rep.firstPassYield.pass, 1);
    assert.equal(rep.retro.passes, 1);
    assert.equal(rep.retro.mergedPrs, 2);
  } finally {
    rmSync(p, { force: true });
  }
});

test('run-id subcommand: echoes SHIP_DAG_RUN_ID when set, else mints (with --label)', () => {
  const run = (env, ...args) => execFileSync(process.execPath, [fileURLToPath(new URL('./telemetry.mjs', import.meta.url)), 'run-id', ...args],
    { env: { ...process.env, SHIP_DAG_RUN_ID: '', ...env }, encoding: 'utf8' }).trim();
  assert.equal(run({ SHIP_DAG_RUN_ID: 'sd-20260101-000000-x' }, '--label', 'ignored'), 'sd-20260101-000000-x');
  assert.match(run({}), /^sd-\d{8}-\d{6}$/);
  assert.match(run({}, '--label', 'My Label'), /^sd-\d{8}-\d{6}-my-label$/);
});

// ---- ingest-wave ----------------------------------------------------------

const REF = 'WXYC/dj-site#1';
const REF2 = 'WXYC/dj-site#2';
const STEM = 'WXYC%2Fdj-site%231'; // artifactStem(REF)
const T2 = '2026-10-08T21:00:00.000Z';

/**
 * Run `fn` on a throwaway engine state dir (see engineFixture for what `spec` writes), removed afterwards.
 */
function withStateDir(spec, fn) {
  const fx = engineFixture({ 'ingest-wave': spec });
  try {
    return fn(fx.dirs['ingest-wave']);
  } finally {
    fx.cleanup();
  }
}
const reportPath = (dir, name = 'w1.json') => join(dir, 'state', 'reports', name);
const blocker ={ category: 'correctness', verdict: 'CONFIRMED', file: 'a.js', line: 1, summary: 's' };
/** ingestWave on `file` into a throwaway log, removed afterwards; returns its result plus what the log held. */
const ingestFile = (file, outcomes = {}, opts = {}) => {
  const path = tmpLog();
  try {
    return { ...ingestWave(file, outcomes, { path, warn: () => {}, ...opts }), log: readRecords(path) };
  } finally {
    rmSync(path, { force: true });
  }
};
const ingest = (dir, outcomes, opts) => ingestFile(reportPath(dir), outcomes, opts);
const exitCode = (fn) => { try { fn(); } catch (err) { return err.code; } return 0; };

test('ingest-wave records a terminal wave from its report, sidecar, digest and rounds', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF), stateRow(REF2, { status: 'failed', prUrl: null, prNumber: null })]) },
  sidecar: [sidecarEntry([REF, REF2])],
}, (dir) => {
  putDigest(dir, REF2, { failureReason: 'rate-limited' });
  putReview(dir, REF, '', [blocker], '2026-10-08T19:10:00.000Z');
  putReview(dir, REF, '.r2', [], '2026-10-08T19:20:00.000Z');
  const { records, log } = ingest(dir);
  assert.deepEqual(log.map((r) => r.issue), [1, 2]);
  const [merged, errored] = records;
  assert.deepEqual([merged.finalState, merged.pr, merged.reviewVerdict, merged.bounces, merged.complexity, merged.model, merged.policySource, merged.tuningVersion], ['merged', 11, 'blocking', 1, 'complex', 'opus', 'sidecar', 7]);
  assert.deepEqual([errored.finalState, errored.implStatus, errored.failureReason], ['deferred', 'error', 'rate-limited']);
}));

// Engine stops arrive as the row's own failureReason/stopStage (claude-orchestrator#87); ship-dag scans no transcript for them.
for (const [failureReason, stopStage, status, outcome, want] of [
  ['lease-wait', 'session', 'failed', {}, [['error', 'lease-wait', 'deferred']]],
  ['memory-critical', 'post-check', 'failed', {}, [['error', 'memory-critical', 'deferred']]],
  ['memory-critical', 'launch', 'pending', { finalState: 'deferred' }, [[null, 'memory-critical', 'deferred']]],
  ['memory-critical', 'launch', 'pending', {}, []],
]) {
  test(`ingest-wave: a ${status} ${failureReason} row (${stopStage}) with ${JSON.stringify(outcome)} records ${want.length} resource-stop record(s)`, () => withStateDir({
    reports: { 'w1.json': stateReport([stateRow(REF, { status, prUrl: null, prNumber: null, failureReason, stopStage })]) },
    sidecar: [sidecarEntry([REF])],
  }, (dir) => {
    const { records, log } = ingest(dir, { [REF]: outcome });
    assert.deepEqual(records.map((r) => [r.implStatus, r.failureReason, r.finalState]), want);
    assert.equal(log.length, want.length);
    // A stopped row is no model-quality signal: report() leaves it out of every indicator.
    assert.equal(report(log).firstPassYield.reached, 0);
  }));
}

test('ingest-wave stamps the report stem as reportId, and records ciStatus none for a repo whose config has no postSessionCheck', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF), stateRow(REF2)]) },
  sidecar: [sidecarEntry([REF, REF2])],
  configs: { 'config.json': config([REF, REF2], { repos: { 'WXYC/dj-site': { baseBranch: 'main' } } }) },
}, (dir) => {
  const { records } = ingest(dir);
  assert.deepEqual(records.map((r) => [r.reportId, r.ciStatus]), [['w1', 'none'], ['w1', 'none']]);
  const withCheck = withStateDir({
    reports: { 'w1.json': stateReport([stateRow(REF)]) },
    sidecar: [sidecarEntry()],
    configs: { 'config.json': config([REF], { repos: { 'WXYC/dj-site': { baseBranch: 'main', postSessionCheck: { commands: ['npm test'] } } } }) },
  }, (d) => ingest(d).records[0].ciStatus);
  assert.equal(withCheck, 'pass');
}));

// The engine's rule (claude-orchestrator resolveRepoSettings): a repo's own postSessionCheck, else the config's top-level one.
const CHECK = { commands: ['npm test'] };
for (const [name, over, want] of [
  ['a top-level check under a plain repo entry', { postSessionCheck: CHECK, repos: { 'WXYC/dj-site': { baseBranch: 'main' } } }, 'pass'],
  ['a repo missing from the repos map, with no top-level check', { repos: { 'WXYC/other': { baseBranch: 'main', postSessionCheck: CHECK } } }, 'none'],
  ['no repos map, with a top-level check', { postSessionCheck: CHECK }, 'pass'],
]) {
  test(`ingest-wave: ${name} records ciStatus ${want}`, () => withStateDir({
    reports: { 'w1.json': stateReport([stateRow(REF)]) }, sidecar: [sidecarEntry()], configs: { 'config.json': config([REF], over) },
  }, (dir) => {
    assert.equal(ingest(dir).records[0].ciStatus, want);
  }));
}

// Which repos run no post-session check comes only from a config; without one, "pass" is unchecked.
for (const [name, configs, want] of [['no config matches', {}, 1], ['a config matches', { 'config.json': config([REF, REF2]) }, 0]]) {
  test(`ingest-wave beside a sidecar entry, ${name}: ${want ? 'warns once for the wave' : 'no ciStatus warning'}`, () => withStateDir({
    reports: { 'w1.json': stateReport([stateRow(REF), stateRow(REF2)]) }, sidecar: [sidecarEntry([REF, REF2])], configs,
  }, (dir) => {
    const warnings = [];
    ingest(dir, {}, { warn: (m) => warnings.push(m) });
    assert.equal(warnings.filter((m) => /post-session check/.test(m)).length, want, warnings.join('\n'));
  }));
}

test('ingest-wave: re-ingest is a no-op, and a hand-written record for the same key is not duplicated', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF)]) }, sidecar: [sidecarEntry()],
}, (dir) => {
  const path = join(dir, 'runs.jsonl');
  const hand = join(dir, 'hand.jsonl');
  assert.equal(ingestWave(reportPath(dir), {}, { path, warn: () => {} }).appended, 1);
  assert.equal(ingestWave(reportPath(dir), {}, { path, warn: () => {} }).appended, 0);
  assert.equal(readRecords(path).length, 1);
  appendRecord(base({ runId: RUN, repo: 'WXYC/dj-site', issue: 1, finalState: 'merged' }), { path: hand });
  assert.equal(ingestWave(reportPath(dir), {}, { path: hand, warn: () => {} }).appended, 0);
  assert.equal(readRecords(hand).length, 1);
}));

// sd-20261002-211445's pair: a --retry-failed report re-lists Backend-Service#3042 succeeded with PR 3044,
// as it stood, beside the wxyc-shared#612 it re-ran; the carried-over row is one event, not two.
test('ingest-wave: a row a retry report only carries over is recorded once; the row it re-ran is recorded again', () => {
  const [BS, SH] = ['WXYC/Backend-Service#3042', 'WXYC/wxyc-shared#612'];
  const carried = stateRow(BS, { prUrl: 'https://x/3044', prNumber: 3044 });
  withStateDir({
    reports: {
      '2026-10-07T17-34-55.942Z.json': stateReport([carried, stateRow(SH, { status: 'failed', prUrl: null, prNumber: null })]),
      '2026-10-07T18-14-51.517Z.json': stateReport([carried, stateRow(SH, { prUrl: 'https://x/619', prNumber: 619 })], { startedAt: T1, finishedAt: T2 }),
    },
    sidecar: [sidecarEntry([BS, SH])],
  }, (dir) => {
    const path = join(dir, 'runs.jsonl');
    const appended = ['2026-10-07T17-34-55.942Z.json', '2026-10-07T18-14-51.517Z.json']
      .map((name) => ingestWave(reportPath(dir, name), {}, { path, warn: () => {} }).appended);
    assert.deepEqual(appended, [2, 1]);
    assert.deepEqual(readRecords(path).map((r) => [r.repo, r.finalState, r.pr]),
      [['WXYC/Backend-Service', 'merged', 3044], ['WXYC/wxyc-shared', 'error', null], ['WXYC/wxyc-shared', 'merged', 619]]);
  });
});

// A later report that re-ran the ref (a new PR) ends this wave's window, even one ingest-wave refuses for
// a malformed row, since it still started when it says; one that only carries the row over with the same
// PR (a --retry-failed run of other rows) does not, since its rounds review this PR.
const reran = stateRow(REF, { prUrl: 'https://x/12', prNumber: 12 });
for (const [name, later, want] of [
  ['re-ran it with a new PR', [reran], ['clean', 0, '.r2.json']],
  ['re-ran it with a new PR beside a row with no owner/repo#N ref', [reran, { ref: 'dj-site#9', status: 'failed' }], ['clean', 0, '.r2.json']],
  ['carried it over with the same PR', [stateRow(REF)], ['blocking', 0, '.r3.json']],
]) {
  test(`ingest-wave: rounds before this wave are not its, nor after a later report that ${name}`, () => withStateDir({
    reports: {
      'w1.json': stateReport([stateRow(REF)], { startedAt: T0, finishedAt: T1 }),
      'w2.json': stateReport([...later, stateRow(REF2, { status: 'failed', prUrl: null, prNumber: null })], { startedAt: T1, finishedAt: T2 }),
    },
    sidecar: [sidecarEntry()],
  }, (dir) => {
    putReview(dir, REF, '', [blocker], '2026-10-08T18:00:00.000Z'); // before this wave
    putReview(dir, REF, '.r2', [], '2026-10-08T19:30:00.000Z'); // this wave
    putReview(dir, REF, '.r3', [blocker], '2026-10-08T20:30:00.000Z'); // after w2 started
    const [rec] = ingest(dir, { [REF]: { finalState: 'blocked-hitl' } }).records;
    assert.deepEqual([rec.reviewVerdict, rec.bounces, rec.reviewPath.slice(-want[2].length)], want);
  }));
}

test('ingest-wave: a later report listing only other refs does not end this ref\'s window', () => withStateDir({
  reports: {
    'w1.json': stateReport([stateRow(REF)], { startedAt: T0, finishedAt: T2 }),
    'w2.json': stateReport([stateRow(REF2)], { startedAt: T1, finishedAt: T2 }),
  },
  sidecar: [sidecarEntry()],
}, (dir) => {
  putReview(dir, REF, '', [blocker], '2026-10-08T19:30:00.000Z');
  putReview(dir, REF, '.r2', [], '2026-10-08T20:30:00.000Z'); // after w2 started, e.g. a re-gate after rebase
  const [rec] = ingest(dir, { [REF]: { finalState: 'blocked-hitl' } }).records;
  assert.deepEqual([rec.reviewVerdict, rec.bounces, rec.reviewPath.endsWith('.r2.json')], ['blocking', 1, true]);
}));

// Review rounds are the run's, not the engine dir's: a retry dir (sd-…-w3c) keeps its rounds under the base
// run's reviews/, and a later report in any family dir that re-ran the ref ends an earlier report's window.
test('ingest-wave reads rounds from the reviews/ of every run-family dir, windowed by every family dir\'s reports', () => {
  const fx = engineFixture({
    [RUN]: { reports: { 'w1.json': stateReport([stateRow(REF)]) }, sidecar: [sidecarEntry()] },
    [`${RUN}-w3c`]: { reports: { 'w1.json': stateReport([reran], { startedAt: T1, finishedAt: T2 }) }, sidecar: [sidecarEntry()] },
  });
  try {
    const { [RUN]: run, [`${RUN}-w3c`]: retry } = fx.dirs;
    putReview(run, REF, '', [], '2026-10-08T19:30:00.000Z'); // the base run's wave
    putReview(run, REF, '.r2', [], '2026-10-08T20:30:00.000Z'); // the retry's, kept under the base run
    const round = (tag) => join(run, 'reviews', `${artifactStem(REF)}${tag}.json`);
    assert.deepEqual([retry, run].map((dir) => ingestFile(reportPath(dir)).records[0].reviewPath), [round('.r2'), round('')]);
  } finally {
    fx.cleanup();
  }
});

test('ingest-wave warns and reads its own dir\'s rounds when the dir holding the run family cannot be listed', (t) => {
  const fx = engineFixture({ [RUN]: {
    reports: { 'w1.json': stateReport([stateRow(REF)]) }, sidecar: [sidecarEntry()],
    reviews: [{ ref: REF, tag: '', findings: [blocker], at: '2026-10-08T19:10:00.000Z' }, { ref: REF, tag: '.r2', findings: [], at: '2026-10-08T19:20:00.000Z' }],
  } });
  try {
    const run = fx.dirs[RUN];
    chmodSync(fx.base, 0o311); // searchable, so the run dir opens, but not listable
    try { readdirSync(fx.base); return t.skip('running as a user the mode does not bind'); } catch {}
    const warnings = [];
    const [rec] = ingestFile(reportPath(run), {}, { warn: (m) => warnings.push(m) }).records;
    assert.deepEqual([rec.reviewVerdict, rec.bounces], ['blocking', 1]);
    assert.ok(warnings.some((m) => m.includes(fx.base) && /cannot list/.test(m)), warnings.join('\n'));
  } finally {
    chmodSync(fx.base, 0o755);
    fx.cleanup();
  }
});

test('ingest-wave reads a state dir once when its path differs in case from the name its family listing gives', (t) => {
  const fx = engineFixture({ [RUN]: {
    reports: { 'w1.json': stateReport([stateRow(REF)]) }, sidecar: [sidecarEntry()],
    reviews: [{ ref: REF, tag: '', findings: [blocker], at: '2026-10-08T19:10:00.000Z' }, { ref: REF, tag: '.r2', findings: [], at: '2026-10-08T19:20:00.000Z' }],
  } });
  try {
    const shouted = join(fx.base, RUN.toUpperCase());
    if (!existsSync(shouted)) return t.skip('case-sensitive file system');
    const [rec] = ingestFile(reportPath(shouted)).records;
    assert.deepEqual([rec.reviewVerdict, rec.bounces], ['blocking', 1]);
  } finally {
    fx.cleanup();
  }
});

test('ingest-wave: a torn round file reads as blocking, never clean', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF)]) }, sidecar: [sidecarEntry()],
}, (dir) => {
  putReview(dir, REF, '', '{"findings": [', '2026-10-08T19:10:00.000Z');
  assert.equal(ingest(dir, { [REF]: { finalState: 'blocked-hitl' } }).records[0].reviewVerdict, 'blocking');
}));

test('ingest-wave: a torn failure digest is warned about and leaves failureReason null', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF, { status: 'failed', prUrl: null, prNumber: null })]) },
  sidecar: [sidecarEntry()],
}, (dir) => {
  putDigest(dir, REF, '{"failureReason": "rate-');
  const warnings = [];
  const [rec] = ingest(dir, {}, { warn: (m) => warnings.push(m) }).records;
  assert.deepEqual([rec.implStatus, rec.failureReason], ['error', null]);
  assert.ok(warnings.some((m) => /unreadable digest/.test(m)), warnings.join('\n'));
}));

// A retry or a later wave rewrites the ref's digest, so one written outside this wave is not its failure.
for (const [when, at, want] of [
  ['during this wave', '2026-10-08T19:30:00.000Z', 'rate-limited'],
  ['before this wave started', '2026-10-08T18:00:00.000Z', null],
  ['after a retry listing the ref started', '2026-10-08T20:30:00.000Z', null],
]) {
  test(`ingest-wave: a failure digest written ${when} is ${want ? '' : 'not '}this wave's`, () => withStateDir({
    reports: {
      'w1.json': stateReport([stateRow(REF, { status: 'failed', prUrl: null, prNumber: null })], { startedAt: T0, finishedAt: T1 }),
      'w2.json': stateReport([stateRow(REF)], { startedAt: T1, finishedAt: T2 }),
    },
    sidecar: [sidecarEntry()],
  }, (dir) => {
    putDigest(dir, REF, { failureReason: 'rate-limited' }, at);
    assert.equal(ingest(dir).records[0].failureReason, want);
  }));
}

// A copied state dir loses mtimes, so a digest stamped with its report's id is assigned by the id alone.
for (const [what, body, at, want] of [
  ['stamped with this report, mtime outside the wave', { reportId: 'w1', failureReason: 'rate-limited' }, '2026-10-08T18:00:00.000Z', 'rate-limited'],
  ['stamped with another report, mtime inside the wave', { reportId: 'w2', failureReason: 'rate-limited' }, '2026-10-08T19:30:00.000Z', null],
  ['unstamped, mtime outside the wave', { failureReason: 'rate-limited' }, '2026-10-08T18:00:00.000Z', null],
]) {
  test(`ingest-wave: a failure digest ${what} is ${want ? '' : 'not '}this wave's`, () => withStateDir({
    reports: {
      'w1.json': stateReport([stateRow(REF, { status: 'failed', prUrl: null, prNumber: null })], { startedAt: T0, finishedAt: T1 }),
      'w2.json': stateReport([stateRow(REF)], { startedAt: T1, finishedAt: T2 }),
    },
    sidecar: [sidecarEntry()],
  }, (dir) => {
    putDigest(dir, REF, body, at);
    assert.equal(ingest(dir).records[0].failureReason, want);
  }));
}

// A stamped round belongs to the wave its id names, whatever its mtime: a late round (a resume, or a point-E
// continuation reviewed after a later wave re-ran the ref) and one in a copied reviews/ dir alike. A stamp that is not a
// string, or names no report of the run family (a typo, an unsubstituted placeholder, a filename), is windowed by mtime.
// w2 re-ran the ref with another PR, so w1's mtime window ends at T1 and w2's starts there.
for (const [what, meta, at, inW1, inW2] of [
  ['stamped with w1, mtime before both waves', { reportId: 'w1' }, '2026-10-08T18:00:00.000Z', true, false],
  ['stamped with w1, mtime after w1 ended (a late round)', { reportId: 'w1' }, '2026-10-08T20:30:00.000Z', true, false],
  ['stamped with w2, mtime inside w1', { reportId: 'w2' }, '2026-10-08T19:30:00.000Z', false, true],
  ['unstamped, mtime inside w1', {}, '2026-10-08T19:30:00.000Z', true, false],
  ['unstamped, mtime inside w2', {}, '2026-10-08T20:30:00.000Z', false, true],
  ['unstamped, mtime before both waves', {}, '2026-10-08T18:00:00.000Z', false, false],
  ['stamped null, mtime inside w1', { reportId: null }, '2026-10-08T19:30:00.000Z', true, false],
  ['stamped with a number, mtime inside w1', { reportId: 1 }, '2026-10-08T19:30:00.000Z', true, false],
  ['stamped with an unsubstituted placeholder, mtime inside w1', { reportId: '{REPORT_ID}' }, '2026-10-08T19:30:00.000Z', true, false],
  ['stamped with a filename, mtime inside w2', { reportId: 'w2.json' }, '2026-10-08T20:30:00.000Z', false, true],
]) {
  test(`ingest-wave: a review round ${what} is ${inW1 ? 'w1' : inW2 ? 'w2' : 'neither wave'}'s`, () => withStateDir({
    reports: {
      'w1.json': stateReport([stateRow(REF)], { startedAt: T0, finishedAt: T1 }),
      'w2.json': stateReport([stateRow(REF, { prNumber: 12 })], { startedAt: T1, finishedAt: T2 }),
    },
    sidecar: [sidecarEntry()],
  }, (dir) => {
    putReview(dir, REF, '', JSON.stringify({ issue: 1, meta, findings: [] }), at);
    assert.deepEqual(['w1.json', 'w2.json'].map((w) => ingestFile(reportPath(dir, w)).records[0].reviewPath !== null), [inW1, inW2]);
  }));
}

// A stamp that names no report of the run family warns and falls back to mtime, rather than dropping the round from every wave.
for (const [what, ids, warned] of [
  ['both rounds stamped with the unsubstituted placeholder', ['{REPORT_ID}', '{REPORT_ID}'], ['', '.r2']],
  ['round 2 stamped with a mistyped id', ['w1', 'wl'], ['.r2']],
]) {
  test(`ingest-wave: ${what} still counts both rounds, and warns for each unknown id`, () => withStateDir({
    reports: { 'w1.json': stateReport([stateRow(REF)]) },
    sidecar: [sidecarEntry()],
  }, (dir) => {
    putReview(dir, REF, '', JSON.stringify({ issue: 1, meta: { trigger: 'initial', reportId: ids[0] }, findings: [{ ...blocker, blocking: true }] }), '2026-10-08T19:10:00.000Z');
    putReview(dir, REF, '.r2', JSON.stringify({ issue: 1, meta: { trigger: 'review-loop', reportId: ids[1] }, findings: [] }), '2026-10-08T19:20:00.000Z');
    const warnings = [];
    const [rec] = ingest(dir, {}, { warn: (m) => warnings.push(m) }).records;
    assert.deepEqual([rec.finalState, rec.reviewVerdict, rec.bounces, basename(rec.reviewPath)], ['merged', 'blocking', 1, `${STEM}.r2.json`]);
    assert.deepEqual(warnings.filter((m) => m.includes('names no report')).map((m) => basename(m.split(':')[0])), warned.map((t) => `${STEM}${t}.json`));
  }));
}

// A stamp that names a report of the run which does not list the ref is no better than an unknown one: that report's
// ingest never reads the ref's rounds, so the round would belong to no wave. It warns and falls back to mtime.
// w1 lists REF, w2 lists only REF2; REF's round 2 is written during w2 (a re-gate of a PR held over) and stamped w2.
for (const [what, first, second, want] of [
  ['a clean re-gate', [true, 'initial'], [false, 'review-loop'], ['merged', 'blocking', 1, '.r2']],
  ['a blocking rebase round after a clean round 1', [false, 'initial'], [true, 'rebase'], ['merged', 'blocking', 1, '.r2']],
]) {
  test(`ingest-wave: ${what} stamped with a report that does not list the ref warns and is windowed by mtime`, () => withStateDir({
    reports: {
      'w1.json': stateReport([stateRow(REF)], { startedAt: T0, finishedAt: T1 }),
      'w2.json': stateReport([stateRow(REF2, { number: 2 })], { startedAt: T1, finishedAt: T2 }),
    },
    sidecar: [sidecarEntry([REF]), sidecarEntry([REF2])],
  }, (dir) => {
    const body = ([blocking, trigger], reportId) => JSON.stringify({ issue: 1, meta: { trigger, reportId }, findings: blocking ? [{ ...blocker, blocking: true }] : [] });
    putReview(dir, REF, '', body(first, 'w1'), '2026-10-08T19:10:00.000Z');
    putReview(dir, REF, '.r2', body(second, 'w2'), '2026-10-08T20:30:00.000Z');
    const warnings = [];
    const [rec] = ingest(dir, { [REF]: { finalState: 'merged', bounces: 1 } }, { warn: (m) => warnings.push(m) }).records;
    assert.deepEqual([rec.finalState, rec.reviewVerdict, rec.bounces, basename(rec.reviewPath).slice(STEM.length, -'.json'.length)], want);
    assert.deepEqual(warnings.filter((m) => m.includes('lists')).map((m) => basename(m.split(':')[0])), [`${STEM}.r2.json`]);
    const w2Warnings = [];
    assert.deepEqual(ingestFile(reportPath(dir, 'w2.json'), {}, { warn: (m) => w2Warnings.push(m) }).records.map((r) => r.reviewPath), [null]);
    assert.deepEqual(w2Warnings.filter((m) => m.includes('names no report')), []);
  }));
}

// Only a string stamp can name a report, so an unstamped round, a null and a number warn about nothing; an unknown string warns once.
for (const [what, meta, warned] of [
  ['unstamped', {}, 0],
  ['stamped null', { reportId: null }, 0],
  ['stamped with a number', { reportId: 1 }, 0],
  ['stamped with an unknown id', { reportId: 'wl' }, 1],
]) {
  test(`ingest-wave: a review round ${what} warns ${warned} time(s) about its stamp`, () => withStateDir({
    reports: { 'w1.json': stateReport([stateRow(REF)]) },
    sidecar: [sidecarEntry()],
  }, (dir) => {
    putReview(dir, REF, '', JSON.stringify({ issue: 1, meta, findings: [] }), '2026-10-08T19:10:00.000Z');
    const warnings = [];
    ingest(dir, {}, { warn: (m) => warnings.push(m) });
    assert.equal(warnings.filter((m) => m.includes('stamped with report id')).length, warned, warnings.join('\n'));
  }));
}

// A digest stamped with an id that names no report is windowed by mtime, like a round: taken inside the wave, ignored outside it.
for (const [what, at, want] of [
  ['mtime inside the wave', '2026-10-08T19:30:00.000Z', 'rate-limited'],
  ['mtime before the wave', '2026-10-08T18:00:00.000Z', null],
]) {
  test(`ingest-wave: a failure digest stamped with an unknown id, ${what}, is ${want ? '' : 'not '}this wave's, and warns`, () => withStateDir({
    reports: { 'w1.json': stateReport([stateRow(REF, { status: 'failed', prUrl: null, prNumber: null })], { startedAt: T0, finishedAt: T1 }) },
    sidecar: [sidecarEntry()],
  }, (dir) => {
    putDigest(dir, REF, { reportId: 'wl', failureReason: 'rate-limited' }, at);
    const warnings = [];
    assert.equal(ingest(dir, {}, { warn: (m) => warnings.push(m) }).records[0].failureReason, want);
    assert.equal(warnings.filter((m) => m.includes('names no report')).length, 1, warnings.join('\n'));
  }));
}

test('ingest-wave: stamped rounds whose mtimes a copy reversed still count in round order', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF)]) },
  sidecar: [sidecarEntry()],
}, (dir) => {
  putReview(dir, REF, '', JSON.stringify({ issue: 1, meta: { trigger: 'initial', reportId: 'w1' }, findings: [{ ...blocker, blocking: true }] }), '2026-10-08T19:20:00.000Z');
  putReview(dir, REF, '.r2', JSON.stringify({ issue: 1, meta: { trigger: 'review-loop', reportId: 'w1' }, findings: [] }), '2026-10-08T19:10:00.000Z');
  const [rec] = ingest(dir).records;
  assert.deepEqual([rec.finalState, rec.reviewVerdict, rec.bounces, basename(rec.reviewPath)], ['merged', 'blocking', 1, `${STEM}.r2.json`]);
}));

test('ingest-wave: a pre-sidecar wave takes its routing from the matching config, default policy and tuning version 0', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF), stateRow(REF2)]) },
  sidecar: [sidecarEntry(['WXYC/other#9'])],
  configs: {
    'config-other.json': config(['WXYC/other#9']),
    'config.json': config([REF, REF2], { issues: [
      { repo: 'WXYC/dj-site', number: 1, complexity: 'complex', effort: 'high', model: 'opus' },
      { repo: 'WXYC/dj-site', number: 2 },
    ] }),
  },
}, (dir) => {
  const warnings = [];
  const [a, b] = ingest(dir, {}, { warn: (m) => warnings.push(m) }).records;
  assert.deepEqual([a.runId, a.complexity, a.effort, a.model, a.policySource, a.tuningVersion], [RUN, 'complex', 'high', 'opus', 'default', 0]);
  assert.deepEqual([b.complexity, b.effort, b.model, b.policySource, b.tuningVersion], ['normal', 'medium', 'sonnet', 'default', 0]);
  assert.ok(warnings.some((m) => /config/.test(m) && /tuningVersion 0/.test(m)), warnings.join('\n'));
}));

// A whole-wave retry re-emits the same ref set, possibly with escalated routing, after this report started.
for (const source of ['sidecar entry', 'config']) {
  test(`ingest-wave: a ${source} re-emitted after this report started is not this wave's routing`, () => withStateDir({
    reports: { 'w1.json': stateReport([stateRow(REF)]) },
    sidecar: source === 'config' ? [] : [
      { ...sidecarEntry(), emittedAt: EMITTED },
      { ...sidecarEntry(), emittedAt: T1, issues: [{ ref: REF, complexity: 'complex', model: 'haiku' }] },
    ],
    configs: source === 'config' ? { 'config.json': config([REF], { defaultModel: 'opus' }), 'config-r2.json': stamped(T1, config([REF], { defaultModel: 'haiku' })) } : {},
  }, (dir) => {
    assert.equal(ingest(dir).records[0].model, 'opus');
  }));
}

test('ingest-wave: an empty report beside a config without an issues array records nothing', () => withStateDir({
  reports: { 'w1.json': stateReport([]) },
  configs: { 'config-other.json': { name: 'ship-dag-x' } },
}, (dir) => {
  assert.deepEqual(ingest(dir).log, []);
}));

test('ingest-wave: a pre-sidecar config kept under <stateDir>/state/ is found too', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF)]) },
  configs: { 'state/config.json': config([REF], { defaultModel: 'opus' }) },
}, (dir) => {
  const [rec] = ingest(dir).records;
  assert.deepEqual([rec.model, rec.policySource], ['opus', 'default']);
}));

test('ingest-wave: a torn sidecar line is reported through the warn it is handed', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF)]) },
  files: { 'ship-dag-wave.jsonl': `{torn\n${JSON.stringify(sidecarEntry())}\n` },
}, (dir) => {
  const warnings = [];
  assert.equal(ingest(dir, {}, { warn: (m) => warnings.push(m) }).records[0].policySource, 'sidecar');
  assert.match(warnings.join('\n'), /skipped 1 unreadable line/);
}));

test('ingest-wave: a report with no configName, and no sidecar entry or config to name the run, exits 3', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF)], { configName: undefined }) },
}, (dir) => {
  assert.equal(exitCode(() => ingest(dir)), 3);
}));

test('ingest-wave: a wave with no sidecar entry or config warns and records default routing at tuning version 0', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF)]) },
}, (dir) => {
  const warnings = [];
  const [rec] = ingest(dir, {}, { warn: (m) => warnings.push(m) }).records;
  assert.deepEqual([rec.runId, rec.complexity, rec.model, rec.policySource, rec.tuningVersion], [RUN, 'normal', null, 'default', 0]);
  assert.ok(warnings.some((m) => /no sidecar entry or config/.test(m)), warnings.join('\n'));
}));

test('ingest-wave: a find-pr row records the PR from --outcomes', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF, { prUrl: null, prNumber: null })]) }, sidecar: [sidecarEntry()],
}, (dir) => {
  assert.equal(ingest(dir, { [REF]: { pr: 42 } }).records[0].pr, 42);
}));

// Each cause names its own remedy: a PR row already has its PR, so the find-pr remedy cannot clear a blocking last round.
const FIND_PR_HINT = `--outcomes '{"<ref>":{"pr":N}}'`;
const MERGED_HINT = `'{"<ref>":{"finalState":"merged","bounces":N}}'`;
test('ingest-wave refuses a half-supplied wave (exit 2), naming both find-pr remedies', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF), stateRow(REF2, { prUrl: null, prNumber: null })]) }, sidecar: [sidecarEntry([REF, REF2])],
}, (dir) => {
  const path = join(dir, 'runs.jsonl');
  assert.throws(() => ingestWave(reportPath(dir), {}, { path, warn: () => {} }), (err) => {
    // Only the prefix, the ref and the hint: deriveWaveRecords' wording between them is #99's to change.
    assert.equal(err.code, 2);
    assert.match(err.message, /^half-supplied wave/);
    assert.ok(err.message.includes(REF2), err.message);
    assert.ok(err.message.includes(FIND_PR_HINT), err.message);
    assert.ok(err.message.includes(`'{"<ref>":{"finalState":"blocked-hitl","hitl":{"pointB":true}}}'`), err.message);
    assert.ok(!err.message.includes(MERGED_HINT), err.message);
    return true;
  });
  assert.equal(existsSync(path), false, 'nothing is appended');
}));

for (const [name, rows, want, notWant] of [
  ['a PR row whose last round blocks', [stateRow(REF), stateRow(REF2, { prNumber: 12 })], [REF, REF2, MERGED_HINT, 'point B'], [FIND_PR_HINT]],
  ['both causes', [stateRow(REF), stateRow(REF2, { prUrl: null, prNumber: null })], [REF, REF2, MERGED_HINT, FIND_PR_HINT], []],
]) {
  test(`ingest-wave refuses ${name} (exit 2) with the remedy for each cause present`, () => withStateDir({
    reports: { 'w1.json': stateReport(rows) }, sidecar: [sidecarEntry([REF, REF2])],
  }, (dir) => {
    putReview(dir, REF, '', [blocker], '2026-10-08T19:10:00.000Z');
    putReview(dir, REF2, '', [blocker], '2026-10-08T19:10:00.000Z');
    assert.throws(() => ingest(dir), (err) => {
      assert.equal(err.code, 2);
      assert.match(err.message, /^half-supplied wave/);
      for (const s of want) assert.ok(err.message.includes(s), `${s} in ${err.message}`);
      for (const s of notWant) assert.ok(!err.message.includes(s), `${s} not in ${err.message}`);
      return true;
    });
  }));
}

for (const [name, rel] of [['not in a reports dir', 'state/w1.json'], ['in a reports dir outside state', 'other/reports/w1.json']]) {
  test(`ingest-wave: a report ${name} exits 2, since its state dir is unknown`, () => withStateDir({
    files: { [rel]: stateReport([stateRow(REF)]) }, sidecar: [sidecarEntry()],
  }, (dir) => {
    assert.equal(exitCode(() => ingestFile(join(dir, rel))), 2);
  }));
}

const prLess = stateRow(REF, { status: 'failed', prUrl: null, prNumber: null });
const badOutcomes = [
  // [name, outcomes, what the message must name besides the ref, the report's row]
  ['an unknown ref', { 'WXYC/nope#5': {} }, /WXYC\/nope#5/],
  ['a non-object', [], /object/],
  ['pr zero', { [REF]: { pr: 0 } }, /pr/],
  ['pr a string', { [REF]: { pr: '11' } }, /pr/],
  ['finalState off the enum', { [REF]: { finalState: 'done' } }, /finalState/],
  ['bounces negative', { [REF]: { bounces: -1 } }, /bounces/],
  ['bounces fractional', { [REF]: { bounces: 1.5 } }, /bounces/],
  ['hitl.pointB a string', { [REF]: { hitl: { pointB: 'yes' } } }, /hitl\.pointB/],
  ['findings not strings', { [REF]: { findings: [1] } }, /findings/],
  ['tokens a string', { [REF]: { tokens: '9' } }, /tokens/],
  ['pressureOverride a string', { [REF]: { pressureOverride: 'yes' } }, /pressureOverride/],
  ['pressureOverride false', { [REF]: { pressureOverride: false } }, /pressureOverride/],
  ['an unknown field', { [REF]: { finalstate: 'blocked-hitl' } }, /finalstate/],
  ['an unknown hitl field', { [REF]: { hitl: { pointB: true, pointA: true } } }, /hitl\.pointA/],
  ['a pr other than the report row\'s', { [REF]: { pr: 42 } }, /pr 42.*11/],
  ['finalState merged where neither the row nor --outcomes has a PR', { [REF]: { finalState: 'merged' } }, /finalState/, prLess],
];
for (const [name, outcomes, want, row = stateRow(REF)] of badOutcomes) {
  test(`ingest-wave: --outcomes with ${name} exits 2`, () => withStateDir({
    reports: { 'w1.json': stateReport([row]) }, sidecar: [sidecarEntry()],
  }, (dir) => {
    assert.throws(() => ingest(dir, outcomes), (err) => err.code === 2 && want.test(err.message)
      && (name === 'a non-object' || name === 'an unknown ref' || err.message.includes(REF)));
  }));
}

test('ingest-wave: a well-formed --outcomes entry is applied', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF)]) }, sidecar: [sidecarEntry()],
}, (dir) => {
  const [rec] = ingest(dir, { [REF]: { finalState: 'blocked-hitl', bounces: 2, hitl: { pointB: true }, findings: ['f'], tokens: null } }).records;
  assert.deepEqual([rec.finalState, rec.bounces, rec.hitl.pointB, rec.findings, rec.tokens], ['blocked-hitl', 2, true, ['f'], null]);
}));

test('ingest-wave: --outcomes pressureOverride: true is accepted and reaches the log record', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF)]) }, sidecar: [sidecarEntry()],
}, (dir) => {
  const { records, log } = ingest(dir, { [REF]: { pressureOverride: true } });
  assert.equal(records[0].pressureOverride, true);
  assert.equal(log[0].pressureOverride, true);
}));

test('ingest-wave: pressureOverride on a resumed rate-limit death lands on the death, not the continuation', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF, { status: 'failed', prUrl: null, prNumber: null })]) }, sidecar: [sidecarEntry()],
}, (dir) => {
  putDigest(dir, REF, { failureReason: 'rate-limited' });
  // The overridden engine ran the session that died; point E's continuation is a later resume without CO_PRESSURE_OVERRIDE.
  const { records } = ingest(dir, { [REF]: { pr: 2, pressureOverride: true } });
  assert.deepEqual(records.map((r) => [r.finalState, r.failureReason, r.pressureOverride]), [['deferred', 'rate-limited', true], ['merged', null, undefined]]);
}));

test('ingest-wave: finalState merged on a PR-less row is accepted alongside the PR --outcomes supplies', () => withStateDir({
  reports: { 'w1.json': stateReport([prLess]) }, sidecar: [sidecarEntry()],
}, (dir) => {
  const [rec] = ingest(dir, { [REF]: { finalState: 'merged', pr: 42 } }).records;
  assert.deepEqual([rec.finalState, rec.pr], ['merged', 42]);
}));

for (const [name, report] of [
  ['unparseable', '{not json'],
  ['without an issues array', { configName: 'x', startedAt: T0 }],
  ['with a row lacking an owner/repo#N ref', stateReport([stateRow('dj-site#1')])],
  ['without a startedAt', stateReport([stateRow(REF)], { startedAt: undefined })],
  ['with an unparseable startedAt', stateReport([stateRow(REF)], { startedAt: 'last tuesday' })],
]) {
  test(`ingest-wave: a report ${name} exits 3`, () => withStateDir({ reports: { 'w1.json': report }, sidecar: [sidecarEntry()] }, (dir) => {
    assert.equal(exitCode(() => ingest(dir)), 3);
  }));
}

// The messages ingest-wave gave before it read reports through readWaveReports.
for (const [name, reports, want] of [
  ['that does not exist', {}, /cannot read the report: ENOENT/],
  ['with a bad ref and a bad startedAt', { 'w1.json': stateReport([stateRow('dj-site#1')], { startedAt: 'x' }) }, /a row has no owner\/repo#N ref/],
]) {
  test(`ingest-wave: a report ${name} exits 3 with the message it always gave`, () => withStateDir({ reports, sidecar: [sidecarEntry()] }, (dir) => {
    assert.throws(() => ingest(dir), (err) => err.code === 3 && want.test(err.message));
  }));
}

test('ingest-wave: a report under state/reports/ without a .json name is still read', () => withStateDir({
  reports: { 'w1.txt': stateReport([stateRow(REF)]) }, sidecar: [sidecarEntry()],
}, (dir) => {
  assert.equal(ingestFile(reportPath(dir, 'w1.txt')).records.length, 1);
}));

test('ingest-wave: a wave with no terminal row records nothing, and reads no digest for it', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF, { status: 'running', prNumber: null })]) }, sidecar: [sidecarEntry()],
}, (dir) => {
  putDigest(dir, REF, { failureReason: 'rate-limited' }, '2026-10-08T18:00:00.000Z'); // an earlier wave's
  const warnings = [];
  assert.deepEqual(ingest(dir, {}, { warn: (m) => warnings.push(m) }).log, []);
  assert.deepEqual(warnings.filter((m) => /digest/.test(m)), []);
}));

test('ingest-wave: a failed append is warned about and the rest continue', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF), stateRow(REF2)]) }, sidecar: [sidecarEntry([REF, REF2])], files: { 'a-file': '' },
}, (dir) => {
  const warnings = [];
  const path = join(dir, 'a-file');
  const out = ingestWave(reportPath(dir), {}, { path: join(path, 'runs.jsonl'), warn: (m) => warnings.push(m) });
  assert.equal(out.appended, 0);
  assert.equal(warnings.filter((m) => /could not append/.test(m)).length, 2, warnings.join('\n'));
}));

test('ingest-wave CLI: usage, bad outcomes, an unreadable log and a malformed report map to exit codes; --outcomes=<json> is read', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF)]), 'bad.json': '{' }, sidecar: [sidecarEntry()],
}, (dir) => {
  const log = join(dir, 'runs.jsonl');
  const cli = (args, env = {}) => spawnSync(process.execPath, [fileURLToPath(new URL('./telemetry.mjs', import.meta.url)), 'ingest-wave', ...args],
    { env: { ...process.env, SHIP_DAG_TELEMETRY: log, ...env }, encoding: 'utf8' });
  const status = (...args) => cli(args).status;
  assert.equal(status(), 2, 'no report');
  assert.equal(status(reportPath(dir), reportPath(dir)), 2, 'two reports');
  assert.equal(status(reportPath(dir), '--outcomes'), 2, '--outcomes with no value');
  assert.equal(status(reportPath(dir), '--outcome', '{}'), 2, 'an unknown flag');
  assert.equal(status(reportPath(dir), '--outcomes', '{nope'), 2, 'unparseable --outcomes');
  assert.equal(status(reportPath(dir, 'bad.json')), 3, 'a malformed report');
  assert.equal(cli([reportPath(dir)], { SHIP_DAG_TELEMETRY: dir }).status, 1, 'an unreadable log is not a malformed report');
  const ok = cli([reportPath(dir), `--outcomes={"${REF}":{"finalState":"blocked-hitl"}}`]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /1 appended/);
  assert.deepEqual(readRecords(log).map((r) => r.finalState), ['blocked-hitl']);
}));

// --- cost.implement ---
const sess = (id, cost) => JSON.stringify({ type: 'result', session_id: id, total_cost_usd: cost, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } });
const logOf = (ref, ...lines) => ({ [`state/logs/issue-${artifactStem(ref)}.log`]: lines.join('\n') });
const costOf = (ids, cost) => ({ costUsd: cost, input: ids.length, output: 2 * ids.length, cacheRead: 3 * ids.length, cacheCreate: 4 * ids.length, sessions: ids.length, sessionIds: ids });

test('ingest-wave: attaches cost.implement summed over a ref\'s sessions, only to rows it records', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF), stateRow(REF2, { status: 'running', prUrl: null, prNumber: null })]) },
  sidecar: [sidecarEntry([REF, REF2])],
  files: { ...logOf(REF, sess('a', 1), sess('b', 0.5)), ...logOf(REF2, sess('c', 9)) },
}, (dir) => {
  const { records } = ingest(dir);
  assert.deepEqual(records.map((r) => r.cost), [{ implement: costOf(['a', 'b'], 1.5) }]);
}));

test('ingest-wave: a session an earlier record of the run family lists, its repo in any case, is not counted again; another ref\'s or run family\'s record does not exclude it', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF)]) }, sidecar: [sidecarEntry()],
  files: logOf(REF, sess('a', 1), sess('b', 0.5), sess('c', 2)),
}, (dir) => {
  const path = tmpLog();
  try {
    const prior = (over, ids) => appendRecord({ runId: `${RUN}-b`, repo: 'WXYC/dj-site', issue: 1, complexity: 'normal', triageStatus: 'clear', path: 'engine', finalState: 'error', implStatus: 'error', cost: { implement: costOf(ids, 1) }, ...over }, { path });
    prior({}, ['a']);
    prior({ repo: 'wxyc/DJ-Site' }, ['c']); // a hand-written record of the same ref, cased differently
    prior({ issue: 2 }, ['b']); // same run family and repo, another issue
    prior({ repo: 'WXYC/Backend-Service' }, ['b']); // same run family and issue number, another repo
    prior({ runId: 'sd-20261001-090000' }, ['b']); // same ref, another run family
    prior({ cost: null }, []); // a null cost reads as none
    assert.deepEqual(ingestWave(reportPath(dir), {}, { path, warn: () => {} }).records[0].cost, { implement: costOf(['b'], 0.5) });
  } finally { rmSync(path, { force: true }); }
}));

test('ingest-wave: reads the transcript the engine named from the report row\'s ref, as written', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow('WXYC/dj-site#01')]) }, sidecar: [sidecarEntry(['WXYC/dj-site#01'])],
  files: logOf('WXYC/dj-site#01', sess('a', 1)),
}, (dir) => {
  assert.deepEqual(ingest(dir).records.map((r) => r.cost), [{ implement: costOf(['a'], 1) }]);
}));

test('ingest-wave: what implementCost warns about reaches ingestWave\'s warn', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF)]) }, sidecar: [sidecarEntry()],
  files: logOf(REF, JSON.stringify({ type: 'result', total_cost_usd: 1 })),
}, (dir) => {
  const warned = [];
  assert.equal(ingest(dir, {}, { warn: (m) => warned.push(m) }).records[0].cost, undefined);
  assert.ok(warned.some((m) => /no session_id/.test(m)), warned.join('\n'));
}));

test('ingest-wave: a skipped row never reached implement, so its record takes no cost and leaves the log\'s sessions for the ref\'s next one', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF, { status: 'skipped', prUrl: null, prNumber: null })]) }, sidecar: [sidecarEntry()],
  files: logOf(REF, sess('a', 1)),
}, (dir) => {
  const { records } = ingest(dir);
  assert.deepEqual(records.map((r) => [r.implStatus, r.cost]), [[null, undefined]]);
}));

test('ingest-wave: a point-E row derives two records, and its sessions are counted once between them', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF, { status: 'failed', prUrl: null, prNumber: null })]) }, sidecar: [sidecarEntry()],
  files: logOf(REF, sess('a', 1), sess('b', 0.5)),
}, (dir) => {
  putDigest(dir, REF, { failureReason: 'rate-limited' });
  const { records } = ingest(dir, { [REF]: { pr: 12, finalState: 'merged' } });
  assert.equal(records.length, 2);
  assert.deepEqual(records.flatMap((r) => r.cost?.implement?.sessionIds ?? []), ['a', 'b']);
}));

test('ingest-wave: a row that lists sessionIds takes only those sessions, and a ran-false row takes none', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF, { ran: true, sessionIds: ['b', 'c'] }), stateRow(REF2, { status: 'failed', prUrl: null, prNumber: null, ran: false })]) },
  sidecar: [sidecarEntry([REF, REF2])],
  files: { ...logOf(REF, sess('a', 1), sess('b', 0.5), sess('c', 2)), ...logOf(REF2, sess('d', 9)) },
}, (dir) => {
  const { records } = ingest(dir);
  assert.deepEqual(records.map((r) => r.cost), [{ implement: costOf(['b', 'c'], 2.5) }, undefined]);
}));

test('ingest-wave: a backfilled earlier report takes only its own sessions, not the later re-run\'s', () => withStateDir({
  reports: {
    'w1.json': stateReport([stateRow(REF, { status: 'failed', prUrl: null, prNumber: null, ran: true, sessionIds: ['a'] })]),
    'w2.json': stateReport([stateRow(REF, { ran: true, sessionIds: ['b'] })], { startedAt: T1, finishedAt: T2 }),
  },
  sidecar: [sidecarEntry()],
  files: logOf(REF, sess('a', 1), sess('b', 0.5)),
}, (dir) => {
  const log = join(dir, 'runs.jsonl');
  assert.equal(ingestWave(reportPath(dir, 'w1.json'), {}, { path: log, warn: () => {} }).appended, 1);
  assert.deepEqual(readRecords(log).map((r) => r.cost?.implement?.sessionIds), [['a']]);
  ingestWave(reportPath(dir, 'w2.json'), {}, { path: log, warn: () => {} });
  assert.deepEqual(readRecords(log).map((r) => r.cost?.implement?.sessionIds), [['a'], ['b']]);
}));

// A row a later report only carries over (ran false, listed unchanged by an earlier report) derives no record: whichever order the two
// are ingested in, each report's own event is recorded once, under its own reportId, with its sessions' cost.
for (const [name, rows, want] of [
  ['a merge', [{ ran: true, sessionIds: ['a'] }, { ran: false }], { mid: ['w1', 'w2'], first: [], second: [['w1', ['a']]] }],
  ['a skipped row', [{ status: 'skipped', prUrl: null, prNumber: null, ran: false }, { status: 'skipped', prUrl: null, prNumber: null, ran: false }], { mid: ['w1', 'w2'], first: [], second: [['w1', undefined]] }],
]) {
  test(`ingest-wave: ${name} the later report carries over derives nothing, so ingesting it first leaves the earlier report whole`, () => {
    const fx = engineFixture({ [RUN]: {
      reports: { 'w1.json': stateReport([stateRow(REF, rows[0])]), 'w2.json': stateReport([stateRow(REF, rows[1])], { startedAt: T1, finishedAt: T2 }) },
      sidecar: [sidecarEntry()], files: logOf(REF, sess('a', 1)),
    } });
    const log = tmpLog();
    const [w1, w2] = ['w1.json', 'w2.json'].map((n) => reportPath(fx.dirs[RUN], n));
    const audited = () => audit(RUN, { baseDir: fx.base, records: readRecords(log), warn: () => {} }).notIngested.map((w) => w.id);
    const logged = () => readRecords(log).map((r) => [r.reportId, r.cost?.implement?.sessionIds]);
    try {
      assert.equal(ingestWave(w2, {}, { path: log, warn: () => {} }).appended, 0);
      assert.deepEqual([logged(), audited()], [want.first.length ? want.first : [], want.mid]);
      assert.equal(ingestWave(w1, {}, { path: log, warn: () => {} }).appended, 1);
      assert.deepEqual([logged(), audited()], [want.second, []]);
      assert.equal(ingestWave(w2, {}, { path: log, warn: () => {} }).appended, 0);
    } finally {
      fx.cleanup();
      rmSync(log, { force: true });
    }
  });
}

// The earlier reports `carriedOver` compares a row to are the family's that started before this one: not this report, not a later one.
test('ingest-wave: a ran-false row is its own event when no earlier report lists it: the report is not its own earlier, and a later one is no earlier', () => withStateDir({
  reports: {
    'w1.json': stateReport([stateRow(REF, { status: 'skipped', prUrl: null, prNumber: null, ran: false })], { startedAt: T0, finishedAt: T1 }),
    'w2.json': stateReport([stateRow(REF, { status: 'skipped', prUrl: null, prNumber: null, ran: false })], { startedAt: T1, finishedAt: T2 }),
  },
  sidecar: [sidecarEntry()],
}, (dir) => {
  assert.deepEqual(ingestFile(reportPath(dir, 'w1.json')).records.map((r) => [r.reportId, r.ran]), [['w1', false]]);
}));

// A later row that carries ran says whether it re-ran the ref: ran false does not end this wave's window, ran true does.
for (const [name, later, want] of [
  ['ran false, with a new PR', stateRow(REF, { prUrl: 'https://x/12', prNumber: 12, ran: false }), ['blocking', 0, '.r3.json']],
  ['ran true, with the same PR', stateRow(REF, { ran: true }), ['clean', 0, '.r2.json']],
  ['ran "false" (no boolean, so no fact), with a new PR', stateRow(REF, { prUrl: 'https://x/12', prNumber: 12, ran: 'false' }), ['clean', 0, '.r2.json']],
  ['ran "true" (no boolean, so no fact), with the same PR', stateRow(REF, { ran: 'true' }), ['blocking', 0, '.r3.json']],
]) {
  test(`ingest-wave: a later report's row with ${name} ${want[2] === '.r2.json' ? 'ends' : 'does not end'} this wave's window`, () => withStateDir({
    reports: {
      'w1.json': stateReport([stateRow(REF)], { startedAt: T0, finishedAt: T1 }),
      'w2.json': stateReport([later], { startedAt: T1, finishedAt: T2 }),
    },
    sidecar: [sidecarEntry()],
  }, (dir) => {
    putReview(dir, REF, '.r2', [], '2026-10-08T19:30:00.000Z');
    putReview(dir, REF, '.r3', [blocker], '2026-10-08T20:30:00.000Z');
    const [rec] = ingest(dir, { [REF]: { finalState: 'blocked-hitl' } }).records;
    assert.deepEqual([rec.reviewVerdict, rec.bounces, rec.reviewPath.slice(-want[2].length)], want);
  }));
}

// escalation-policy.md point E, item 5: a continuation that finishes after its report's 6.3 already ran (point E's grill
// chose defer or stop, or the session resumed) is recorded by adding its outcome to that report's outcomes file and
// re-running 6.3. The first ingest recorded the death alone; the re-run must dedupe that death and append the continuation.
for (const [label, continuation, want] of [
  ['merged PR 12', { pr: 12 }, ['merged', 12, 'pushed']],
  ['stalled at point B without a PR', { finalState: 'blocked-hitl', hitl: { pointB: true } }, ['blocked-hitl', null, 'error']],
]) {
  test(`ingest-wave: re-ingesting a deferred point-E death with its continuation (${label}) appends only the continuation`, () => withStateDir({
    reports: { 'w1.json': stateReport([stateRow(REF, { status: 'failed', prUrl: null, prNumber: null })]) }, sidecar: [sidecarEntry()],
    files: logOf(REF, sess('a', 1)),
  }, (dir) => {
    putDigest(dir, REF, { failureReason: 'rate-limited' });
    const path = join(dir, 'runs.jsonl');
    assert.equal(ingestWave(reportPath(dir), {}, { path, warn: () => {} }).appended, 1);
    assert.equal(ingestWave(reportPath(dir), { [REF]: continuation }, { path, warn: () => {} }).appended, 1);
    const log = readRecords(path);
    assert.deepEqual(log.map((r) => [r.finalState, r.pr, r.implStatus, r.failureReason]),
      [['deferred', null, 'error', 'rate-limited'], [...want, null]]);
    assert.equal(log[1].hitl.pointB, continuation.hitl?.pointB === true);
    // The death already carries the row's sessions, so the continuation does not count them again.
    assert.deepEqual(log.map((r) => r.cost?.implement?.sessionIds), [['a'], undefined]);
    assert.equal(ingestWave(reportPath(dir), { [REF]: continuation }, { path, warn: () => {} }).appended, 0);
  }));
}

test('ingest-wave: a row with no log or no session result gets no cost', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF), stateRow(REF2)]) }, sidecar: [sidecarEntry([REF, REF2])],
  files: logOf(REF2, '{"type":"assistant"}'),
}, (dir) => {
  assert.deepEqual(ingest(dir).records.map((r) => r.cost), [undefined, undefined]);
}));

test('normalizeRecord: validates cost.implement; a record without cost, or with cost null, stays valid', () => {
  assert.deepEqual(normalizeRecord(base({ cost: { implement: costOf(['a'], 1) } }), FIXED).cost, { implement: costOf(['a'], 1) });
  assert.equal(normalizeRecord(base(), FIXED).cost, undefined);
  assert.equal(normalizeRecord(base({ cost: null }), FIXED).cost, null);
  for (const cost of [5, [], { implement: 3 }, { implement: { ...costOf(['a'], 1), sessions: 2 } }, { implement: { ...costOf(['a', 'a'], 1) } }, { implement: { ...costOf(['a', 'a'], 1), sessions: 1 } }, { implement: { ...costOf(['a'], 1), costUsd: 'x' } }, { implement: { ...costOf(['a'], 1), sessions: 1.5 } }, { implement: { ...costOf(['a'], 1), sessionIds: [1] } }, { implement: { ...costOf(['a'], 1), input: -1 } }]) {
    assert.throws(() => normalizeRecord(base({ cost }), FIXED), /bad cost/, JSON.stringify(cost));
  }
});

// (malformed-row is not here: readWaveReport refuses a row with no owner/repo#N ref, so ingestWave exits 3 before deriveWaveRecords can refuse.)
// The exit code is the kind's, never the message's: SKILL.md (T6) documents 2 as "supply --outcomes" and 3 as "malformed".
for (const [kind, rows, report, code] of [
  ['half-supplied', [stateRow(REF, { prUrl: null, prNumber: null })], {}, 2],
  ['no-run-id', [stateRow(REF)], { configName: undefined }, 3],
]) {
  test(`ingest-wave: a ${kind} refusal exits ${code}, however its message is worded`, () => withStateDir({
    reports: { 'w1.json': stateReport(rows, report) },
  }, (dir) => {
    assert.equal(exitCode(() => ingest(dir)), code);
    // Reword every refusal as it is built; the exit code must not follow.
    Object.defineProperty(WaveRefusal.prototype, 'kind', {
      configurable: true,
      set(v) { Object.defineProperty(this, 'kind', { value: v, writable: true, enumerable: true, configurable: true }); this.message = 'reworded, matching no prefix'; },
    });
    try {
      assert.throws(() => ingest(dir), (err) => err.code === code && /reworded/.test(err.message));
    } finally {
      delete WaveRefusal.prototype.kind;
    }
  }));
}

// audit: names waves whose terminal rows have no covering record, unreadable reports, and never-reported routing.
describe('audit', () => {
  const RUN_A = 'sd-20261008-153059';
  const REF3 = 'WXYC/dj-site#3';
  const quiet = { warn: () => {} };
  const logged = (over = {}) => ({ kind: 'issue', runId: RUN_A, implStatus: 'pushed', repo: 'WXYC/dj-site', issue: 1, finalState: 'merged', ts: T1, ...over });
  const family = (specs, fn) => {
    const fx = engineFixture(specs);
    try {
      return fn(fx.base, fx.dirs);
    } finally {
      fx.cleanup();
    }
  };
  const audit_ = (base, records) => audit(RUN_A, { baseDir: base, records, ...quiet });

  test('names the wave of a family dir that was not ingested, folds in a -b dir, and leaves a -board dir out', () => family({
    [RUN_A]: { reports: { 'w1.json': stateReport([stateRow(REF)]) }, sidecar: [sidecarEntry([REF])] },
    [`${RUN_A}-b`]: { reports: { 'w2.json': stateReport([stateRow(REF2)]) }, sidecar: [sidecarEntry([REF2])] },
    [`${RUN_A}-board`]: { reports: { 'w3.json': stateReport([stateRow(REF3)]) } },
  }, (base, dirs) => {
    const out = audit_(base, [logged()]);
    assert.deepEqual(out.notIngested.map((w) => [w.dir, w.id, w.refs, w.source]), [[dirs[`${RUN_A}-b`], 'w2', [REF2], 'sidecar']]);
    assert.deepEqual([out.unreadable, out.neverReported], [[], { sidecar: [], configs: [] }]);
  }));

  test('a ran-false row a later report carries over is covered by the first report\'s record; its repeated worktree failure is not', () => family({
    [RUN_A]: {
      reports: {
        'w1.json': stateReport([stateRow(REF, { status: 'skipped', prNumber: null, ran: false }), stateRow(REF2, { status: 'failed', prNumber: null, ran: false })]),
        'w2.json': stateReport([stateRow(REF, { status: 'skipped', prNumber: null, ran: false }), stateRow(REF2, { status: 'failed', prNumber: null, ran: false })], { startedAt: '2026-10-08T20:00:00.000Z' }),
      },
      sidecar: [sidecarEntry([REF, REF2])],
    },
  }, (base) => {
    const first = [logged({ reportId: 'w1', ran: false, implStatus: null, finalState: 'deferred' }), logged({ issue: 2, reportId: 'w1', ran: false, implStatus: 'error', finalState: 'error' })];
    assert.deepEqual(audit_(base, first).notIngested.map((w) => [w.id, w.refs]), [['w2', [REF2]]]);
    assert.deepEqual(audit_(base, [...first, logged({ issue: 2, reportId: 'w2', ran: false, implStatus: 'error', finalState: 'error' })]).notIngested, []);
  }));

  test('one dir holding two waves names only the one not ingested, and a report with no terminal row is not named', () => family({
    [RUN_A]: {
      reports: {
        'w1.json': stateReport([stateRow(REF)]),
        'w2.json': stateReport([stateRow(REF2, { status: 'failed', prNumber: null })], { startedAt: '2026-10-08T20:00:00.000Z' }),
        'w3.json': stateReport([stateRow(REF3, { status: 'interrupted', prNumber: null })], { startedAt: '2026-10-08T21:00:00.000Z' }),
      },
      sidecar: [sidecarEntry([REF]), sidecarEntry([REF2]), sidecarEntry([REF3])],
    },
  }, (base) => {
    assert.deepEqual(audit_(base, [logged()]).notIngested.map((w) => w.id), ['w2']);
  }));

  test('counts the terminal rows it examined, and those with a PR, beside the uncovered ones: a carried-over row once per report, an interrupted row not at all', () => family({
    [RUN_A]: {
      reports: {
        'w1.json': stateReport([stateRow(REF), stateRow(REF2, { status: 'failed', prNumber: null }), stateRow(REF3, { status: 'interrupted', prNumber: null })]),
        'w2.json': stateReport([stateRow(REF), stateRow(REF2, { status: 'failed', prNumber: null })], { startedAt: '2026-10-08T20:00:00.000Z' }),
      },
      sidecar: [sidecarEntry([REF, REF2, REF3]), sidecarEntry([REF, REF2])],
    },
  }, (base) => {
    const out = audit_(base, [logged()]);
    assert.equal(out.terminalRows, 4);
    assert.deepEqual(out.prRows, { total: 2, uncovered: 0 });
    assert.deepEqual(out.notIngested.map((w) => w.refs), [[REF2], [REF2]]);
  }));

  test('prRows counts an uncovered row that has a PR', () => family({
    [RUN_A]: { reports: { 'w1.json': stateReport([stateRow(REF), stateRow(REF2, { prNumber: 12 })]) }, sidecar: [sidecarEntry([REF, REF2])] },
  }, (base) => {
    const out = audit_(base, [logged()]);
    assert.deepEqual([out.terminalRows, out.prRows], [2, { total: 2, uncovered: 1 }]);
  }));

  test('a --retry-failed report whose re-run failure has no record of its own is named, though its carried-over merge is covered by the first report\'s record', () => family({
    [RUN_A]: {
      reports: {
        'w1.json': stateReport([stateRow(REF, { status: 'failed', prNumber: null }), stateRow(REF2)]),
        'w2.json': stateReport([stateRow(REF, { status: 'failed', prNumber: null }), stateRow(REF2)], { startedAt: '2026-10-08T20:00:00.000Z' }),
      },
    },
  }, (base) => {
    const records = [logged({ reportId: 'w1', finalState: 'error', implStatus: 'error' }), logged({ issue: 2, reportId: 'w1' })];
    assert.deepEqual(audit_(base, records).notIngested.map((w) => [w.id, w.refs]), [['w2', [REF]]]);
    assert.deepEqual(audit_(base, [...records, logged({ reportId: 'w2', finalState: 'error', implStatus: 'error' })]).notIngested, []);
  }));

  // The wave-5 spec case. A death hand-written once wave 3 was under way is at or after wave 3's start, so only
  // the row's PR keeps that PR-less failure's record from covering the merge.
  for (const [when, ts] of [['during wave 2', '2026-10-08T19:30:00.000Z'], ['once wave 3 was under way', '2026-10-08T20:30:00.000Z']]) {
    test(`names a wave-3 merge never ingested, whose wave-2 rate-limit death was hand-written ${when}`, () => family({
      [RUN_A]: {
        reports: {
          'w2.json': stateReport([stateRow(REF, { status: 'failed', prUrl: null, prNumber: null })]),
          'w3.json': stateReport([stateRow(REF)], { startedAt: T1, finishedAt: '2026-10-08T21:00:00.000Z' }),
        },
        digests: [{ ref: REF, body: { status: 'failed', failureReason: 'rate-limited' } }],
      },
    }, (base) => {
      const death = logged({ implStatus: 'error', finalState: 'deferred', failureReason: 'rate-limited', ts });
      assert.deepEqual(audit_(base, [death]).notIngested.map((w) => [w.id, w.refs]), [['w3', [REF]]]);
    }));
  }

  // Audit reads a row's rate-limit from the digest ingest would read: the one written inside the report's window.
  for (const [when, at, rateLimited] of [
    ['during the wave', '2026-10-08T19:30:00.000Z', true],
    ['before the wave', '2026-10-08T18:00:00.000Z', false],
    ['after a later report re-ran the ref', '2026-10-08T20:30:00.000Z', false],
  ]) {
    test(`a PR-less failure's rate-limited digest written ${when} is ${rateLimited ? '' : 'not '}its death`, () => family({
      [RUN_A]: {
        reports: { 'w1.json': stateReport([stateRow(REF, { status: 'failed', prUrl: null, prNumber: null })]) },
        digests: [{ ref: REF, body: { status: 'failed', failureReason: 'rate-limited' }, at }],
      },
      // A retry dir's report ends the window too.
      [`${RUN_A}-b`]: {
        reports: { 'w2.json': stateReport([stateRow(REF, { status: 'failed', prUrl: null, prNumber: null })], { startedAt: T1, finishedAt: '2026-10-08T21:00:00.000Z' }) },
      },
    }, (base) => {
      const w2 = logged({ implStatus: 'error', finalState: 'error', reportId: 'w2', ts: '2026-10-08T21:00:00.000Z' });
      const plain = logged({ implStatus: 'error', finalState: 'error', reportId: 'w1' });
      const death = logged({ ...plain, finalState: 'deferred', failureReason: 'rate-limited' });
      const named = (records) => audit_(base, [w2, ...records]).notIngested.filter((w) => w.id === 'w1').map((w) => w.refs);
      assert.deepEqual([named([plain]), named([death])], rateLimited ? [[[REF]], []] : [[], [[REF]]]);
    }));
  }

  test('names a merge whose only record is the triage defer written before the ref ran', () => family({
    [RUN_A]: { reports: { 'w1.json': stateReport([stateRow(REF)]) } },
  }, (base) => {
    const defer = logged({ implStatus: null, finalState: 'blocked-hitl', ts: '2026-10-08T18:00:00.000Z' });
    assert.deepEqual(audit_(base, [defer]).notIngested.map((w) => w.refs), [[REF]]);
  }));

  test('names a torn report and one with no issues[] as unreadable, and never hands them to waveContextFor', () => family({
    [RUN_A]: { reports: { 'torn.json': '{"issues": [', 'bare.json': { startedAt: T0 }, 'nostart.json': { issues: [stateRow(REF)] } } },
  }, (base) => {
    const warnings = [];
    const out = audit(RUN_A, { baseDir: base, records: [], warn: (m) => warnings.push(m) });
    assert.deepEqual(warnings, [], 'an unreadable report is named in the result, not warned about too');
    assert.deepEqual(out.unreadable.map((u) => basename(u.path)), ['bare.json', 'nostart.json', 'torn.json']);
    assert.match(out.unreadable.find((u) => u.path.endsWith('nostart.json')).error, /startedAt/);
    assert.deepEqual(out.notIngested, []);
  }));

  test('names a sidecar entry and a config-2.json no report matches as never-reported, and a pre-sidecar config-only wave as a wave', () => family({
    [RUN_A]: {
      reports: { 'w1.json': stateReport([stateRow(REF)]), 'w2.json': stateReport([stateRow(REF3)], { startedAt: '2026-10-08T20:00:00.000Z' }) },
      sidecar: [sidecarEntry([REF]), sidecarEntry([REF2])],
      files: { 'config-2.json': config([REF2]) },
      configs: { 'config-3.json': config([REF3]) },
    },
  }, (base, dirs) => {
    const out = audit_(base, [logged()]);
    assert.deepEqual(out.neverReported.sidecar.map((e) => [e.dir, e.refs]), [[dirs[RUN_A], [REF2]]]);
    assert.deepEqual(out.neverReported.configs, [join(dirs[RUN_A], 'config-2.json')]);
    assert.deepEqual(out.notIngested.map((w) => [w.id, w.source]), [['w2', 'config']]);
  }));

  test('scans the older state/ layout for configs too: one a report matched there is not never-reported, one none matched is', () => family({
    [RUN_A]: {
      reports: { 'w1.json': stateReport([stateRow(REF)]) },
      configs: { 'state/config.json': config([REF]), 'state/config-2.json': config([REF2]) },
    },
  }, (base, dirs) => {
    const out = audit_(base, [logged()]);
    assert.deepEqual([out.neverReported.configs, out.notIngested], [[join(dirs[RUN_A], 'state', 'config-2.json')], []]);
  }));

  test('refuses a run id no dir under the base dir belongs to, rather than reading as all clear', () => family({
    [RUN_A]: { reports: { 'w1.json': stateReport([stateRow(REF)]) } },
  }, (base) => {
    assert.throws(() => audit('sd-2026100-153059', { baseDir: base, records: [], ...quiet }), /no dir under .* belongs to run sd-2026100-153059/);
    assert.throws(() => audit('sd-2026100-153059', { baseDir: base, records: [], ...quiet }), (err) => NO_ENGINE_DIR.test(err.message), 'tripwires skips a family on this refusal');
  }));

  test('CLI: prints the audit as JSON from the XDG engine dir and the log, refuses a missing or extra run id, and exits 1 for a run with no dir', () => family({
    [RUN_A]: { reports: { 'w1.json': stateReport([stateRow(REF)]) } },
  }, (base) => {
    const xdg = join(base, 'xdg');
    mkdirSync(join(xdg, 'ship-dag', 'engine'), { recursive: true });
    renameSync(join(base, RUN_A), join(xdg, 'ship-dag', 'engine', RUN_A));
    const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('./telemetry.mjs', import.meta.url)), 'audit', ...args],
      { env: { ...process.env, XDG_STATE_HOME: xdg, SHIP_DAG_TELEMETRY: join(base, 'runs.jsonl') }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(cli(RUN_A).stdout).notIngested.map((w) => w.refs), [[REF]]);
    assert.equal(cli().status, 2);
    assert.equal(cli(RUN_A, RUN_A).status, 2);
    const typo = cli('sd-2026100-153059');
    assert.deepEqual([typo.status, typo.stdout], [1, '']);
    assert.match(typo.stderr, /^audit: no dir under .* belongs to run sd-2026100-153059/);
  }));
});

// tripwires: the CLI over lib/tripwires.mjs (the evaluators have their own tests there). A stub `gh` first on PATH
// marks any call to GitHub; XDG_STATE_HOME and SHIP_DAG_TELEMETRY keep it off the real state dir.
describe('tripwires', () => {
  const cli = (args, fn, records = [{ tuningVersion: 1, ts: '2026-10-30T00:00:00Z' }]) => {
    const fx = engineFixture({});
    try {
      const bin = join(fx.base, 'bin');
      mkdirSync(bin);
      appendFileSync(join(bin, 'gh'), `#!/bin/sh\ntouch ${join(fx.base, 'gh-called')}\nexit 1\n`);
      chmodSync(join(bin, 'gh'), 0o755);
      const path = join(fx.base, 'runs.jsonl');
      for (const r of records) appendRecord({ runId: 'sd-20261020-100000', repo: 'o/r', issue: 1, complexity: 'normal', triageStatus: 'clear', path: 'workflow', finalState: 'merged', ...r }, { path });
      const res = spawnSync(process.execPath, [fileURLToPath(new URL('./telemetry.mjs', import.meta.url)), 'tripwires', ...args(fx.base)],
        { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: join(fx.base, 'xdg'), SHIP_DAG_TELEMETRY: path }, encoding: 'utf8' });
      fn(res, fx.base);
    } finally {
      fx.cleanup();
    }
  };

  test('prints every tripwire as JSON, with T-escapes insufficient-data and a hint, and never calls gh', () => cli(() => ['--now', '2026-11-01T00:00:00Z'], (res, base) => {
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.deepEqual(out.map((o) => o.id).slice(0, 2), ['T-explore-unique', 'T-escapes']);
    assert.equal(out.find((o) => o.id === 'T-fallback').state, 'insufficient-data');
    assert.match(out.find((o) => o.id === 'T-escapes').hint, /run telemetry\.mjs escapes > <file> and pass --escapes <file>/);
    assert.equal(existsSync(join(base, 'gh-called')), false);
  }));

  test('evaluates the window of tuning.json\'s version', () => cli(() => ['--now', '2026-11-01T00:00:00Z'], (res) => {
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).find((o) => o.id === 'T-fallback').state, 'tripped');
  }, Array.from({ length: 30 }, () => ({ tuningVersion: loadTuning().version, ts: '2026-10-30T00:00:00Z' }))));

  test('--escapes reads a saved escapes run from a file', () => cli((base) => {
    appendFileSync(join(base, 'escapes.json'), JSON.stringify({ byTuningVersion: { 1: { prs: 60, escaped: 3 } } }));
    return ['--escapes', join(base, 'escapes.json')];
  }, (res) => {
    assert.equal(res.status, 0, res.stderr);
    assert.match(JSON.parse(res.stdout).find((o) => o.id === 'T-escapes').hint, /still being collected/);
  }));

  test('refuses an unreadable --escapes file with exit 1, and a bad --now or an unknown option with exit 2', () => {
    cli(() => ['--escapes', '/nonexistent/escapes.json'], (res) => assert.deepEqual([res.status, res.stdout, /^tripwires: /.test(res.stderr)], [1, '', true]));
    cli(() => ['--now', 'soon'], (res) => assert.equal(res.status, 2));
    cli(() => ['--bogus'], (res) => assert.equal(res.status, 2));
  });
});

// The wiring SKILL.md documents for the mechanics above: the headings, audit classes and subcommands it names, and
// (below) every --outcomes cell of step 6.3's table, run through ingestWave on a report of the situation its row names.
describe('SKILL.md telemetry wiring', () => {
  const skill = readFileSync(fileURLToPath(new URL('../SKILL.md', import.meta.url)), 'utf8');

  test('names step 6.3 and the audit classes, and no longer the url-encoded round file', () => {
    assert.match(skill, /^### 6\.3 Ingest the wave$/m);
    for (const cls of ['notIngested', 'unreadable', 'neverReported']) assert.ok(skill.includes(`\`${cls}\``), cls);
    assert.ok(!skill.includes('<url-encoded-ref>'));
  });

  test('has the Review block write meta.reportId beside meta.trigger', () => {
    assert.ok(skill.includes('meta: { trigger: "{TRIGGER}", reportId: "{REPORT_ID}" }'));
  });

  test('documents every telemetry.mjs subcommand the CLI dispatches', () => {
    // The list comes from the CLI's own usage line, so a new subcommand fails here until SKILL.md documents it.
    const source = readFileSync(fileURLToPath(new URL('./telemetry.mjs', import.meta.url)), 'utf8');
    const cmds = source.match(/usage: telemetry\.mjs <([\w|-]+)>/)[1].split('|');
    // ...and the usage line must name exactly the commands main() dispatches, so dropping one from it fails too.
    const dispatched = [...source.matchAll(/\bcmd === '([\w-]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...cmds].sort(), [...new Set(dispatched)].sort());
    for (const cmd of cmds) assert.ok(skill.includes(`telemetry.mjs" ${cmd}`), cmd);
  });
});

// Step 6.3's --outcomes table, cell by cell: each JSON cell (with <ref> and N filled in) must pass validateOutcomes and
// derive the events the row's situation calls for, so a renamed field or a changed rule fails here, not in a live wave.
describe("SKILL.md step 6.3's --outcomes table", () => {
  const skill = readFileSync(fileURLToPath(new URL('../SKILL.md', import.meta.url)), 'utf8');
  const section = skill.slice(skill.indexOf('### 6.3 Ingest the wave'), skill.indexOf('### 6.5 '));
  const rows = section.split('\n').filter((l) => l.startsWith('| ') && l.includes('{"<ref>"'))
    .map((l) => ({ situation: l.split('|')[1].trim(), cells: [...l.matchAll(/`(\{"<ref>":[^`]*\})`/g)].map((m) => JSON.parse(m[1].replaceAll('<ref>', REF).replace(/\bN\b/g, '2'))) }));
  const findPr = stateRow(REF, { prUrl: null, prNumber: null });
  const blocks = (dir) => putReview(dir, REF, '', [blocker], '2026-10-08T19:10:00.000Z');
  const dies = (dir) => putDigest(dir, REF, { failureReason: 'rate-limited' });
  const deadRow = (failureReason, stopStage) => stateRow(REF, { status: 'failed', prUrl: null, prNumber: null, failureReason, stopStage });
  // situation prefix → the report row, what else the wave left on disk, and per cell the [finalState, pr, hitl.pointB,
  // bounces] of each derived record. pointB and bounces come from the situation, not the cell, so a cell that drops
  // its hitl or its bounces fails here. A merge "after a /review-loop fix" bounced: N is 2 in these cells.
  const situations = [
    ['A find-pr row whose PR step 5 found', findPr, () => {}, [[['merged', 2, false, 0]]]],
    ['A find-pr row point B left without a PR', findPr, () => {}, [[['blocked-hitl', null, true, 0]]]],
    ['A PR whose last round blocks and that went to point B', stateRow(REF), blocks, [[['blocked-hitl', 11, true, 0]]]],
    ['A PR whose last round blocks and that merged', stateRow(REF), blocks, [[['merged', 11, false, 2]]]],
    ["A find-pr row whose found PR's last round blocks", findPr, blocks, [[['blocked-hitl', 2, true, 0]], [['merged', 2, false, 2]]]],
    ['A rate-limit death that point E resumed', stateRow(REF, { status: 'failed', prUrl: null, prNumber: null }), dies,
      [[['deferred', null, false, 0], ['merged', 2, false, 0]], [['deferred', null, false, 0], ['blocked-hitl', null, true, 0]]]],
    ['A `lease-wait` or `memory-critical` row (no PR)', deadRow('lease-wait', 'session'), () => {},
      [[['deferred', null, false, 0], ['merged', 2, false, 0]], [['deferred', null, false, 0], ['blocked-hitl', null, true, 0]]]],
    ['A stopped `pending` row', stateRow(REF, { status: 'pending', prUrl: null, prNumber: null, failureReason: 'memory-critical', stopStage: 'launch' }), () => {}, [[['deferred', null, false, 0]]]],
    ['An engine invocation the user started anyway at point F', stateRow(REF), () => {}, [[['merged', 11, false, 0]]]],
  ];

  test('every row of the table is a situation this test knows, and every situation is in the table', () => {
    assert.deepEqual(rows.map((r) => situations.findIndex(([prefix]) => r.situation.startsWith(prefix))), situations.map((_, i) => i));
  });

  for (const [prefix, row, setUp, want] of situations) {
    test(`${prefix}: each cell ingests to its events`, () => {
      const { cells } = rows.find((r) => r.situation.startsWith(prefix));
      assert.equal(cells.length, want.length);
      cells.forEach((outcome, i) => withStateDir({ reports: { 'w1.json': stateReport([row]) }, sidecar: [sidecarEntry()] }, (dir) => {
        setUp(dir);
        const { records } = ingest(dir, outcome);
        assert.deepEqual(records.map((r) => [r.finalState, r.pr, r.hitl.pointB, r.bounces]), want[i], JSON.stringify(outcome));
        // A resumed death is the infrastructure record (rate-limited, or the engine's lease-wait), then a continuation with no stop of its own.
        if (records.length === 2) assert.deepEqual([records[0].implStatus, ['rate-limited', 'lease-wait'].includes(records[0].failureReason)], ['error', true]);
        assert.ok(records.slice(1).every((r) => r.failureReason === null));
        // Only the point-F cell stamps pressureOverride, and it reaches every derived record except a resumed death's continuation (see the test below).
        assert.ok(records.every((r) => (r.pressureOverride === true) === (outcome[REF].pressureOverride === true)), JSON.stringify(outcome));
      }));
    });
  }
});
