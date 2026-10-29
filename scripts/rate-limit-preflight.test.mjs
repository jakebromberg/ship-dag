// Tests for the step-4 utilization preflight CLI's I/O layer (file discovery
// + reading). The decision math itself is tested in scripts/lib/rate-limit.test.mjs.
// Run: node --test "skills/ship-dag/scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newestLogFile, newestLogFiles, readLatestUtilization, parseArgs } from './rate-limit-preflight.mjs';

let counter = 0;
const tmpBase = () => join(tmpdir(), `ship-dag-preflight-${process.pid}-${counter++}`);

function writeLog(dir, runId, ref, content, mtime) {
  const logsDir = join(dir, runId, 'state', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const p = join(logsDir, `issue-${ref}.log`);
  writeFileSync(p, content);
  if (mtime) utimesSync(p, mtime, mtime);
  return p;
}

const event = (utilization, resetsAtSec, status = 'allowed_warning') =>
  `${JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: {
      status,
      rateLimitType: 'five_hour',
      utilization,
      resetsAt: resetsAtSec,
      unifiedWindows: { five_hour: { utilization, resetsAt: resetsAtSec }, seven_day: { utilization: 0.1, resetsAt: 1788724800 } },
    },
  })}\n`;
const isoResetsAt = (sec) => new Date(sec * 1000).toISOString();

test('newestLogFile: missing base dir → null (fail-open source)', () => {
  assert.equal(newestLogFile(join(tmpdir(), 'ship-dag-preflight-does-not-exist')), null);
});

test('newestLogFile: empty base dir → null', () => {
  const dir = tmpBase();
  mkdirSync(dir, { recursive: true });
  try {
    assert.equal(newestLogFile(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('newestLogFile: picks the most recently modified issue-*.log across run subdirs', () => {
  const dir = tmpBase();
  try {
    const older = writeLog(dir, 'run-a', 'o-r-1', event(0.5, 1788196400), new Date('2026-08-31T20:00:00Z'));
    const newer = writeLog(dir, 'run-b', 'o-r-2', event(0.9, 1788206400), new Date('2026-08-31T22:00:00Z'));
    assert.equal(newestLogFile(dir), newer);
    assert.notEqual(newestLogFile(dir), older);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('newestLogFile: excludes the engine\'s issue-<ref>.stderr.log companions', () => {
  const dir = tmpBase();
  try {
    const p = writeLog(dir, 'run-a', 'o-r-1', event(0.5, 1788196400), new Date('2026-08-31T20:00:00Z'));
    const stderrDir = join(dir, 'run-a', 'state', 'logs');
    const stderrPath = join(stderrDir, 'issue-o-r-1.stderr.log');
    writeFileSync(stderrPath, 'some stderr noise\n');
    utimesSync(stderrPath, new Date('2026-08-31T23:59:59Z'), new Date('2026-08-31T23:59:59Z')); // newer than p
    assert.equal(newestLogFile(dir), p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLatestUtilization: reads the newest event from the newest log file', () => {
  const dir = tmpBase();
  try {
    writeLog(dir, 'run-a', 'o-r-1', event(0.5, 1788196400), new Date('2026-08-31T20:00:00Z'));
    writeLog(dir, 'run-b', 'o-r-2', event(0.3, 1788200000) + event(0.91, 1788206400), new Date('2026-08-31T22:00:00Z'));
    const result = readLatestUtilization(dir);
    assert.equal(result.utilization, 0.91);
    assert.equal(result.resetsAt, isoResetsAt(1788206400));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLatestUtilization: no readable source → null utilization (caller fails open)', () => {
  assert.deepEqual(readLatestUtilization(join(tmpdir(), 'ship-dag-preflight-does-not-exist')), {
    utilization: null,
    resetsAt: null,
    source: null,
  });
});

test('readLatestUtilization: a log file with no rate_limit_event lines → null utilization', () => {
  const dir = tmpBase();
  try {
    const p = writeLog(dir, 'run-a', 'o-r-1', `${JSON.stringify({ type: 'system', subtype: 'init' })}\n`);
    const result = readLatestUtilization(dir);
    assert.equal(result.utilization, null);
    assert.equal(result.source, p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- fail-open guards: readdirSync must never throw the preflight (item 1) ---

test('newestLogFile: base dir is a file, not a directory (ENOTDIR) → null, does not throw', () => {
  const p = join(tmpdir(), `ship-dag-preflight-file-${process.pid}-${counter++}`);
  writeFileSync(p, 'not a directory\n');
  try {
    assert.doesNotThrow(() => newestLogFile(p));
    assert.equal(newestLogFile(p), null);
  } finally {
    rmSync(p, { force: true });
  }
});

test('newestLogFiles: a run subdir whose state/logs path is a file, not a directory, is skipped rather than thrown', () => {
  const dir = tmpBase();
  try {
    // run-a: state/logs is a plain file (e.g. a half-migrated/corrupt run dir).
    const badLogsDir = join(dir, 'run-a', 'state');
    mkdirSync(badLogsDir, { recursive: true });
    writeFileSync(join(badLogsDir, 'logs'), 'not a directory\n');
    // run-b: a normal, readable log.
    const good = writeLog(dir, 'run-b', 'o-r-2', event(0.5, 1788196400), new Date('2026-08-31T20:00:00Z'));
    assert.doesNotThrow(() => newestLogFiles(dir));
    assert.deepEqual(newestLogFiles(dir), [good]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLatestUtilization: base dir is a file, not a directory → fails open (null utilization, no throw)', () => {
  const p = join(tmpdir(), `ship-dag-preflight-file-${process.pid}-${counter++}`);
  writeFileSync(p, 'not a directory\n');
  try {
    assert.doesNotThrow(() => readLatestUtilization(p));
    assert.deepEqual(readLatestUtilization(p), { utilization: null, resetsAt: null, source: null });
  } finally {
    rmSync(p, { force: true });
  }
});

// --- newest-but-empty shadowing (item 7) ---

test('newestLogFiles: returns candidates newest-first, capped to limit', () => {
  const dir = tmpBase();
  try {
    const a = writeLog(dir, 'run-a', 'o-r-1', event(0.1, 1788196400), new Date('2026-08-31T18:00:00Z'));
    const b = writeLog(dir, 'run-b', 'o-r-2', event(0.2, 1788196400), new Date('2026-08-31T19:00:00Z'));
    const c = writeLog(dir, 'run-c', 'o-r-3', event(0.3, 1788196400), new Date('2026-08-31T20:00:00Z'));
    assert.deepEqual(newestLogFiles(dir), [c, b, a]);
    assert.deepEqual(newestLogFiles(dir, 2), [c, b]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLatestUtilization: a newest-but-empty log does not shadow an older log with a real reading', () => {
  const dir = tmpBase();
  try {
    const older = writeLog(dir, 'run-a', 'o-r-1', event(0.91, 1788206400), new Date('2026-08-31T20:00:00Z'));
    // A just-created log, newest by mtime, with no rate_limit_event yet.
    writeLog(dir, 'run-b', 'o-r-2', `${JSON.stringify({ type: 'system', subtype: 'init' })}\n`, new Date('2026-08-31T23:00:00Z'));
    const result = readLatestUtilization(dir);
    assert.equal(result.utilization, 0.91);
    assert.equal(result.source, older);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLatestUtilization: stays cheap — a reading past maxCandidates newer, empty logs is not found', () => {
  const dir = tmpBase();
  try {
    const withData = writeLog(dir, 'run-old', 'o-r-old', event(0.91, 1788206400), new Date('2026-08-31T10:00:00Z'));
    for (let n = 0; n < 3; n += 1) {
      writeLog(dir, `run-empty-${n}`, `o-r-empty-${n}`, `${JSON.stringify({ type: 'system', subtype: 'init' })}\n`, new Date(`2026-08-31T2${n}:00:00Z`));
    }
    // Within the cap, the older reading is still found.
    const withinCap = readLatestUtilization(dir, { maxCandidates: 4 });
    assert.equal(withinCap.utilization, 0.91);
    assert.equal(withinCap.source, withData);
    // Capped below where the real reading lives — reports none, but still fails open.
    const beyondCap = readLatestUtilization(dir, { maxCandidates: 3 });
    assert.equal(beyondCap.utilization, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- CLI arg validation (item 2) ---

test('parseArgs: defaults when no flags are given', () => {
  assert.deepEqual(parseArgs([]), { baseDir: undefined, threshold: 0.8, waitMaxMinutes: 300 });
});

test('usage line states the 300-minute --wait-max-minutes default', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./rate-limit-preflight.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /\[--wait-max-minutes 300\]/);
});

test('parseArgs: accepts valid --threshold and --wait-max-minutes values', () => {
  const opts = parseArgs(['--base-dir', '/tmp/x', '--threshold', '0.5', '--wait-max-minutes', '15']);
  assert.deepEqual(opts, { baseDir: '/tmp/x', threshold: 0.5, waitMaxMinutes: 15 });
});

test('parseArgs: rejects an empty or blank --threshold instead of silently coercing to 0', () => {
  // Number("") and Number("  ") are 0, not NaN — a missing/blank value would
  // otherwise sail past the finite check and land inside the valid [0, 1]
  // range instead of erroring, the same silent-Number()-coercion trap as the
  // NaN case just below, one input away from it.
  assert.throws(() => parseArgs(['--threshold', '']), /--threshold requires a value/);
  assert.throws(() => parseArgs(['--threshold', '   ']), /--threshold requires a value/);
});

test('parseArgs: rejects a non-numeric --threshold instead of silently coercing to NaN', () => {
  // The bug this guards: a bare Number("abc") is NaN, and NaN compares false
  // against everything, so preflightDecision's `utilization < threshold` check
  // was always false — inverting a healthy 56% window into a HITL fork.
  assert.throws(() => parseArgs(['--threshold', 'abc']), /--threshold must be a number/);
});

test('parseArgs: rejects a --threshold outside [0, 1]', () => {
  assert.throws(() => parseArgs(['--threshold', '1.5']), /--threshold must be <= 1/);
  assert.throws(() => parseArgs(['--threshold', '-0.1']), /--threshold must be >= 0/);
});

test('parseArgs: accepts threshold boundary values 0 and 1', () => {
  assert.equal(parseArgs(['--threshold', '0']).threshold, 0);
  assert.equal(parseArgs(['--threshold', '1']).threshold, 1);
});

test('parseArgs: rejects a non-numeric --wait-max-minutes', () => {
  assert.throws(() => parseArgs(['--wait-max-minutes', 'soon']), /--wait-max-minutes must be a number/);
});

test('parseArgs: rejects a non-positive --wait-max-minutes', () => {
  assert.throws(() => parseArgs(['--wait-max-minutes', '0']), /--wait-max-minutes must be a positive number/);
  assert.throws(() => parseArgs(['--wait-max-minutes', '-5']), /--wait-max-minutes must be a positive number/);
});
