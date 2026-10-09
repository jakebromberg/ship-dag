// Tests for the telemetry log + report. Run: node --test "skills/ship-dag/scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { rmSync, readFileSync, existsSync, appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { normalizeRecord, appendRecord, readRecords, report, renderReport, telemetryPath, ingestWave } from './telemetry.mjs';
import { appendWave } from './lib/wave-sidecar.mjs';
import { artifactStem } from './lib/failure.mjs';

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
const RUN = 'sd-20261008-153059';
const T0 = '2026-10-08T19:00:00.000Z';
const T1 = '2026-10-08T20:00:00.000Z';
const T2 = '2026-10-08T21:00:00.000Z';
const secs = (iso) => Date.parse(iso) / 1000;
const stateRow = (ref, over = {}) => ({ ref, number: Number(ref.split('#')[1]), status: 'succeeded', prUrl: 'https://x/11', prNumber: 11, ...over });
const stateReport = (rows, over = {}) => ({ configName: `ship-dag-${RUN}`, startedAt: T0, finishedAt: T1, issues: rows, ...over });

/**
 * Run `fn` on a throwaway engine state dir, removed afterwards. `reports` maps file name → report,
 * `files` maps a path under the dir → contents (a string is written as is, anything else as JSON).
 */
function withStateDir({ reports = {}, sidecar = [], configs = {}, files = {} }, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ingest-wave-'));
  try {
    mkdirSync(join(dir, 'state', 'reports'), { recursive: true });
    for (const [name, rep] of Object.entries(reports)) writeFileSync(join(dir, 'state', 'reports', name), typeof rep === 'string' ? rep : JSON.stringify(rep));
    for (const entry of sidecar) appendWave(dir, entry);
    for (const [name, cfg] of Object.entries(configs)) writeFileSync(join(dir, name), JSON.stringify(cfg));
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body));
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const reportPath = (dir, name = 'w1.json') => join(dir, 'state', 'reports', name);
/** Write a review round for `ref` with mtime `at`; `findings` is the array, or a string written as is (a torn file). */
const reviewFile = (dir, ref, tag, findings, at) => {
  const path = join(dir, 'reviews', `${artifactStem(ref)}${tag}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof findings === 'string' ? findings : JSON.stringify({ issue: 1, findings }));
  utimesSync(path, secs(at), secs(at));
};
const blocker = { category: 'correctness', verdict: 'CONFIRMED', file: 'a.js', line: 1, summary: 's' };
const sidecarEntry = (refs = [REF]) => ({
  runId: RUN, wave: 1, tuningVersion: 7, blockOn: ['correctness'],
  issues: refs.map((ref) => ({ ref, complexity: 'complex', effort: 'high', effortSource: 'tuning', model: 'opus' })),
});
const config = (refs = [REF], over = {}) => ({
  name: `ship-dag-${RUN}`, defaultModel: 'sonnet', defaultEffort: 'medium',
  issues: refs.map((ref) => ({ repo: ref.split('#')[0], number: Number(ref.split('#')[1]) })),
  ...over,
});
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
  files: { [`state/failure-digest/issue-${artifactStem(REF2)}.json`]: { failureReason: 'rate-limited' } },
}, (dir) => {
  reviewFile(dir, REF, '', [blocker], '2026-10-08T19:10:00.000Z');
  reviewFile(dir, REF, '.r2', [], '2026-10-08T19:20:00.000Z');
  const { records, log } = ingest(dir);
  assert.deepEqual(log.map((r) => r.issue), [1, 2]);
  const [merged, errored] = records;
  assert.deepEqual([merged.finalState, merged.pr, merged.reviewVerdict, merged.bounces, merged.complexity, merged.model, merged.policySource, merged.tuningVersion], ['merged', 11, 'blocking', 1, 'complex', 'opus', 'sidecar', 7]);
  assert.deepEqual([errored.finalState, errored.implStatus, errored.failureReason], ['error', 'error', 'rate-limited']);
}));

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

test('ingest-wave: rounds from an earlier or later wave of the same ref are not this wave\'s', () => withStateDir({
  reports: {
    'w1.json': stateReport([stateRow(REF)], { startedAt: T0, finishedAt: T1 }),
    'w2.json': stateReport([stateRow(REF)], { startedAt: T1, finishedAt: T2 }),
  },
  sidecar: [sidecarEntry()],
}, (dir) => {
  reviewFile(dir, REF, '', [blocker], '2026-10-08T18:00:00.000Z'); // before this wave
  reviewFile(dir, REF, '.r2', [], '2026-10-08T19:30:00.000Z'); // this wave
  reviewFile(dir, REF, '.r3', [blocker], '2026-10-08T20:30:00.000Z'); // the next wave's
  const [rec] = ingest(dir).records;
  assert.deepEqual([rec.reviewVerdict, rec.bounces, rec.reviewPath.endsWith('.r2.json')], ['clean', 0, true]);
}));

test('ingest-wave: a later report listing only other refs does not end this ref\'s window', () => withStateDir({
  reports: {
    'w1.json': stateReport([stateRow(REF)], { startedAt: T0, finishedAt: T2 }),
    'w2.json': stateReport([stateRow(REF2)], { startedAt: T1, finishedAt: T2 }),
  },
  sidecar: [sidecarEntry()],
}, (dir) => {
  reviewFile(dir, REF, '', [blocker], '2026-10-08T19:30:00.000Z');
  reviewFile(dir, REF, '.r2', [], '2026-10-08T20:30:00.000Z'); // after w2 started, e.g. a re-gate after rebase
  const [rec] = ingest(dir).records;
  assert.deepEqual([rec.reviewVerdict, rec.bounces, rec.reviewPath.endsWith('.r2.json')], ['blocking', 1, true]);
}));

test('ingest-wave: a torn round file reads as blocking, never clean', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF)]) }, sidecar: [sidecarEntry()],
}, (dir) => {
  reviewFile(dir, REF, '', '{"findings": [', '2026-10-08T19:10:00.000Z');
  assert.equal(ingest(dir).records[0].reviewVerdict, 'blocking');
}));

test('ingest-wave: a torn failure digest is warned about and leaves failureReason null', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF, { status: 'failed', prUrl: null, prNumber: null })]) },
  sidecar: [sidecarEntry()],
  files: { [`state/failure-digest/issue-${artifactStem(REF)}.json`]: '{"failureReason": "rate-' },
}, (dir) => {
  const warnings = [];
  const [rec] = ingest(dir, {}, { warn: (m) => warnings.push(m) }).records;
  assert.deepEqual([rec.implStatus, rec.failureReason], ['error', null]);
  assert.ok(warnings.some((m) => /unreadable digest/.test(m)), warnings.join('\n'));
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
  const [a, b] = ingest(dir).records;
  assert.deepEqual([a.runId, a.complexity, a.effort, a.model, a.policySource, a.tuningVersion], [RUN, 'complex', 'high', 'opus', 'default', 0]);
  assert.deepEqual([b.complexity, b.effort, b.model, b.policySource, b.tuningVersion], ['normal', 'medium', 'sonnet', 'default', 0]);
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

test('ingest-wave refuses a half-supplied wave (exit 2), naming both find-pr remedies', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF), stateRow(REF2, { prUrl: null, prNumber: null })]) }, sidecar: [sidecarEntry([REF, REF2])],
}, (dir) => {
  const path = join(dir, 'runs.jsonl');
  assert.throws(() => ingestWave(reportPath(dir), {}, { path, warn: () => {} }), (err) => {
    // Only the prefix, the ref and the hint: deriveWaveRecords' wording between them is #99's to change.
    assert.equal(err.code, 2);
    assert.match(err.message, /^half-supplied wave/);
    assert.ok(err.message.includes(REF2), err.message);
    assert.ok(err.message.includes(`--outcomes '{"<ref>":{"pr":N}}'`), err.message);
    assert.ok(err.message.includes(`'{"<ref>":{"finalState":"blocked-hitl","hitl":{"pointB":true}}}'`), err.message);
    return true;
  });
  assert.equal(existsSync(path), false, 'nothing is appended');
}));

for (const [name, rel] of [['not in a reports dir', 'state/w1.json'], ['in a reports dir outside state', 'other/reports/w1.json']]) {
  test(`ingest-wave: a report ${name} exits 2, since its state dir is unknown`, () => withStateDir({
    files: { [rel]: stateReport([stateRow(REF)]) }, sidecar: [sidecarEntry()],
  }, (dir) => {
    assert.equal(exitCode(() => ingestFile(join(dir, rel))), 2);
  }));
}

const badOutcomes = [
  // [name, outcomes, what the message must name besides the ref]
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
  ['an unknown field', { [REF]: { finalstate: 'blocked-hitl' } }, /finalstate/],
  ['an unknown hitl field', { [REF]: { hitl: { pointB: true, pointA: true } } }, /hitl\.pointA/],
];
for (const [name, outcomes, want] of badOutcomes) {
  test(`ingest-wave: --outcomes with ${name} exits 2`, () => withStateDir({
    reports: { 'w1.json': stateReport([stateRow(REF)]) }, sidecar: [sidecarEntry()],
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

test('ingest-wave: a wave with no terminal row records nothing', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF, { status: 'running', prNumber: null })]) }, sidecar: [sidecarEntry()],
}, (dir) => {
  assert.deepEqual(ingest(dir).log, []);
}));

test('ingest-wave: a failed append is warned about and the rest continue', () => withStateDir({
  reports: { 'w1.json': stateReport([stateRow(REF), stateRow(REF2)]) }, sidecar: [sidecarEntry([REF, REF2])],
}, (dir) => {
  const warnings = [];
  const path = join(dir, 'a-file');
  writeFileSync(path, '');
  const out = ingestWave(reportPath(dir), {}, { path: join(path, 'runs.jsonl'), warn: (m) => warnings.push(m) });
  assert.equal(out.appended, 0);
  assert.equal(warnings.length, 2);
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
