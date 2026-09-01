// Tests for the telemetry log + report. Run: node --test "skills/ship-dag/scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  normalizeRecord, appendRecord, readRecords, report, renderReport, telemetryPath,
  recordKey, appendUniqueRecords, loadWaveContext, auditWaves,
} from './telemetry.mjs';

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

// ---- structural emission: engine artifacts → records ----------------------
// Every test below points the log at a temp file. The real run log
// (~/.local/state/ship-dag/runs.jsonl) is collected data and is never written
// by the suite; appendUniqueRecords/auditWaves take an explicit path for
// exactly that reason.

test('recordKey: an issue is keyed by run + ref + outcome, so a rate-limit death and the later merge both survive', () => {
  const death = base({ issue: 5, finalState: 'error', implStatus: 'error', failureReason: 'rate-limited' });
  const merge = base({ issue: 5, finalState: 'merged' });
  assert.notEqual(recordKey(death), recordKey(merge));
  assert.equal(recordKey(base({ issue: 5 })), recordKey(base({ issue: 5, bounces: 3 })));
  assert.equal(recordKey(retroBase()), recordKey(retroBase({ filed: [] })));
  assert.notEqual(recordKey(retroBase()), recordKey(retroBase({ wave: 3 })));
});

test('appendUniqueRecords: appends new records and skips ones already in the log', () => {
  const p = tmpLog();
  try {
    const first = appendUniqueRecords([base({ issue: 1 }), base({ issue: 2 })], { path: p, now: FIXED });
    assert.equal(first.appended.length, 2);
    assert.deepEqual(first.skipped, []);
    // Re-running the same wave close must not double-count it.
    const second = appendUniqueRecords([base({ issue: 1 }), base({ issue: 3 })], { path: p, now: FIXED });
    assert.equal(second.appended.length, 1);
    assert.equal(second.appended[0].issue, 3);
    assert.equal(second.skipped.length, 1);
    assert.deepEqual(readRecords(p).map((r) => r.issue), [1, 2, 3]);
  } finally {
    rmSync(p, { force: true });
  }
});

test('appendUniqueRecords: a duplicate inside one batch is written once', () => {
  const p = tmpLog();
  try {
    const res = appendUniqueRecords([base({ issue: 1 }), base({ issue: 1 })], { path: p, now: FIXED });
    assert.equal(res.appended.length, 1);
    assert.equal(readRecords(p).length, 1);
  } finally {
    rmSync(p, { force: true });
  }
});

test('appendUniqueRecords: one bad record is reported, not fatal — the rest of the wave still lands', () => {
  // Best-effort is non-negotiable: a telemetry failure must never abort a wave,
  // so a record that fails validation is collected in `failed` rather than
  // thrown past the caller and taking its siblings with it.
  const p = tmpLog();
  try {
    const res = appendUniqueRecords(
      [base({ issue: 1 }), base({ issue: 2, finalState: 'nope' }), base({ issue: 3 })],
      { path: p, now: FIXED },
    );
    assert.deepEqual(res.appended.map((r) => r.issue), [1, 3]);
    assert.equal(res.failed.length, 1);
    assert.match(res.failed[0].error, /bad finalState/);
    assert.deepEqual(readRecords(p).map((r) => r.issue), [1, 3]);
  } finally {
    rmSync(p, { force: true });
  }
});

test('appendUniqueRecords: an empty batch never creates the file', () => {
  const p = tmpLog();
  const res = appendUniqueRecords([], { path: p, now: FIXED });
  assert.deepEqual(res.appended, []);
  assert.equal(existsSync(p), false);
});

// A minimal engine state tree: <stateDir>/config.json (or the sidecar) plus
// <stateDir>/state/reports/<ISO>.json — the layout every engine wave leaves behind.
function engineTree(dir, { runId, refs, sidecar = false, status = 'succeeded' }) {
  mkdirSync(join(dir, 'state', 'reports'), { recursive: true });
  const issues = refs.map((ref, i) => ({ number: Number(ref.split('#')[1]), repo: ref.split('#')[0], complexity: 'normal', ref }));
  const ctx = sidecar
    ? { runId, wave: 2, path: 'engine', issues: issues.map((i) => ({ ...i, assignment: 'sonnet' })) }
    : { name: `ship-dag-${runId}`, defaultModel: 'sonnet', issues };
  writeFileSync(join(dir, sidecar ? 'ship-dag-wave.json' : 'config.json'), JSON.stringify(ctx));
  writeFileSync(
    join(dir, 'state', 'reports', '2026-08-29T19-00-00.000Z.json'),
    JSON.stringify({
      configName: `ship-dag-${runId}`,
      startedAt: '2026-08-29T19:00:00.000Z',
      finishedAt: '2026-08-29T19:30:00.000Z',
      issues: refs.map((ref, i) => ({ ref, number: Number(ref.split('#')[1]), status, prNumber: 100 + i })),
    }),
  );
  return join(dir, 'state', 'reports', '2026-08-29T19-00-00.000Z.json');
}

test('loadWaveContext: prefers the sidecar, falls back to config.json, tolerates neither', () => {
  const dir = join(tmpdir(), `ship-dag-ctx-${process.pid}-${counter++}`);
  try {
    const reportPath = engineTree(join(dir, 'run1'), { runId: 'r1', refs: ['o/r#1'], sidecar: true });
    const withSidecar = loadWaveContext(reportPath);
    assert.equal(withSidecar.source, join(dir, 'run1', 'ship-dag-wave.json'));
    assert.equal(withSidecar.context.wave, 2);

    const cfgPath = engineTree(join(dir, 'run2'), { runId: 'r2', refs: ['o/r#1'] });
    const withConfig = loadWaveContext(cfgPath);
    assert.equal(withConfig.source, join(dir, 'run2', 'config.json'));
    assert.equal(withConfig.context.name, 'ship-dag-r2');

    mkdirSync(join(dir, 'run3', 'state', 'reports'), { recursive: true });
    const bare = loadWaveContext(join(dir, 'run3', 'state', 'reports', 'x.json'));
    assert.equal(bare.context, null);
    assert.equal(bare.stateDir, join(dir, 'run3'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auditWaves: names the engine waves whose rows never reached the log', () => {
  const dir = join(tmpdir(), `ship-dag-audit-${process.pid}-${counter++}`);
  try {
    engineTree(join(dir, 'w1'), { runId: 'r1', refs: ['o/r#1', 'o/r#2'] });
    engineTree(join(dir, 'w2'), { runId: 'r2', refs: ['o/r#3'] });
    const records = [
      normalizeRecord(base({ runId: 'r1', repo: 'o/r', issue: 1 }), FIXED),
      // o/r#2 was shipped but never recorded — the under-emission defect itself.
      // o/r#3 was recorded under a *different* runId, so it is accounted for but misattributed.
      normalizeRecord(base({ runId: 'other', repo: 'o/r', issue: 3 }), FIXED),
    ];
    const audit = auditWaves({ baseDir: dir, records });
    assert.equal(audit.waves.length, 2);
    assert.equal(audit.expected, 3);
    assert.deepEqual(audit.missing, ['o/r#2']);
    assert.deepEqual(audit.elsewhere, ['o/r#3']);
    const w1 = audit.waves.find((w) => w.runId === 'r1');
    assert.deepEqual(w1.missing, ['o/r#2']);
    assert.equal(w1.present, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auditWaves: a fully-recorded tree reports no gap; a missing base dir is not an error', () => {
  const dir = join(tmpdir(), `ship-dag-audit-ok-${process.pid}-${counter++}`);
  try {
    engineTree(join(dir, 'w1'), { runId: 'r1', refs: ['o/r#1'] });
    const audit = auditWaves({ baseDir: dir, records: [normalizeRecord(base({ runId: 'r1', repo: 'o/r', issue: 1 }), FIXED)] });
    assert.deepEqual(audit.missing, []);
    assert.equal(audit.expected, 1);
    const none = auditWaves({ baseDir: join(dir, 'does-not-exist'), records: [] });
    assert.deepEqual(none.waves, []);
    assert.equal(none.expected, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI ingest-wave: a whole wave lands from the engine report; a half-supplied wave is refused', () => {
  const dir = join(tmpdir(), `ship-dag-cli-${process.pid}-${counter++}`);
  const log = join(dir, 'runs.jsonl');
  const cli = fileURLToPath(new URL('./telemetry.mjs', import.meta.url));
  const run = (args) => spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SHIP_DAG_TELEMETRY: log },
  });
  try {
    const reportPath = engineTree(join(dir, 'w1'), { runId: 'r1', refs: ['o/r#1', 'o/r#2'] });

    // Half the wave supplied → nothing written, and the forgotten ref is named.
    const partial = run(['ingest-wave', reportPath, '--outcomes', '{"o/r#1":"merged"}']);
    assert.equal(partial.status, 2);
    assert.match(partial.stderr, /o\/r#2/);
    assert.equal(existsSync(log), false);

    const full = run(['ingest-wave', reportPath, '--outcomes', '{"o/r#1":"merged","o/r#2":{"finalState":"blocked-hitl","hitl":{"pointB":true}}}']);
    assert.equal(full.status, 0, full.stderr);
    const recs = readRecords(log);
    assert.equal(recs.length, 2);
    assert.deepEqual(recs.map((r) => r.issue), [1, 2]);
    assert.equal(recs[0].path, 'engine');
    assert.equal(recs[0].triageStatus, 'clear');
    assert.equal(recs[0].pr, 100);
    assert.equal(recs[0].ts, '2026-08-29T19:30:00.000Z');
    assert.equal(recs[1].hitl.pointB, true);

    // Re-running the same close is a no-op, not a doubling.
    assert.equal(run(['ingest-wave', reportPath, '--outcomes', '{"o/r#1":"merged","o/r#2":"blocked-hitl"}']).status, 0);
    assert.equal(readRecords(log).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI run-id: mints a fresh id, and echoes an already-exported one', () => {
  const cli = fileURLToPath(new URL('./telemetry.mjs', import.meta.url));
  const fresh = spawnSync(process.execPath, [cli, 'run-id'], { encoding: 'utf8', env: { ...process.env, SHIP_DAG_RUN_ID: '' } });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout.trim(), /^sd-\d{8}-\d{6}$/);
  const labelled = spawnSync(process.execPath, [cli, 'run-id', '--label', 'dj ios 135'], { encoding: 'utf8', env: { ...process.env, SHIP_DAG_RUN_ID: '' } });
  assert.match(labelled.stdout.trim(), /^sd-\d{8}-\d{6}-dj-ios-135$/);
  const existing = spawnSync(process.execPath, [cli, 'run-id'], { encoding: 'utf8', env: { ...process.env, SHIP_DAG_RUN_ID: 'sd-already-minted' } });
  assert.equal(existing.stdout.trim(), 'sd-already-minted');
});

test('CLI ingest-wave: a wave with no resolvable run id is refused, not written ungroupably', () => {
  const dir = join(tmpdir(), `ship-dag-noid-${process.pid}-${counter++}`);
  const log = join(dir, 'runs.jsonl');
  const reportsDir = join(dir, 'run', 'state', 'reports');
  const cli = fileURLToPath(new URL('./telemetry.mjs', import.meta.url));
  try {
    mkdirSync(reportsDir, { recursive: true });
    const reportPath = join(reportsDir, 'r.json');
    // No config, no sidecar, and a report with no configName: nothing to group on.
    writeFileSync(reportPath, JSON.stringify({ issues: [{ ref: 'o/r#1', number: 1, status: 'succeeded' }] }));
    const res = spawnSync(process.execPath, [cli, 'ingest-wave', reportPath, '--outcomes', '{"o/r#1":"merged"}'], {
      encoding: 'utf8', env: { ...process.env, SHIP_DAG_TELEMETRY: log, SHIP_DAG_RUN_ID: '' },
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /no run id/);
    assert.equal(existsSync(log), false);
    // ...and the ambient run id rescues exactly that case.
    const rescued = spawnSync(process.execPath, [cli, 'ingest-wave', reportPath, '--outcomes', '{"o/r#1":"merged"}'], {
      encoding: 'utf8', env: { ...process.env, SHIP_DAG_TELEMETRY: log, SHIP_DAG_RUN_ID: 'sd-from-env' },
    });
    assert.equal(rescued.status, 0, rescued.stderr);
    assert.equal(readRecords(log)[0].runId, 'sd-from-env');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
