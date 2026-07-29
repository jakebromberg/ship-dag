// Tests for the telemetry log + report. Run: node --test "skills/ship-dag/scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { normalizeRecord, appendRecord, readRecords, report, telemetryPath } from './telemetry.mjs';

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

test('report: leading indicators over an 8-record fixture', () => {
  const recs = [
    base({ complexity: 'mechanical', bounces: 0, reviewVerdict: 'clean' }),                 // 1 mech pass
    base({ complexity: 'mechanical', bounces: 0, reviewVerdict: 'nits-only' }),             // 2 mech pass (nit ≠ miss)
    base({ complexity: 'normal', bounces: 1, reviewVerdict: 'blocking' }),                  // 3 normal bounced→merged, miss
    base({ complexity: 'normal', bounces: 0, reviewVerdict: 'clean' }),                     // 4 normal pass
    base({ complexity: 'complex', finalState: 'blocked-hitl', bounces: 2, reviewVerdict: 'blocking', hitl: { pointA: false, pointB: true } }), // 5 complex miss, B
    base({ complexity: 'complex', triageStatus: 'needs-decision', finalState: 'blocked-hitl', implStatus: null, ciStatus: null, reviewVerdict: null, hitl: { pointA: true, pointB: false } }), // 6 point-A defer
    base({ complexity: 'normal', finalState: 'blocked-hitl', implStatus: 'blocked', reviewVerdict: null, hitl: { pointA: false, pointB: true } }), // 7 impl bail, miss, B
    base({ complexity: 'mechanical', bounces: 0, reviewVerdict: 'clean' }),                 // 8 mech pass
  ].map((r) => normalizeRecord(r, FIXED));
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
