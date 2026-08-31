// Tests for the step-4 utilization preflight CLI's I/O layer (file discovery
// + reading). The decision math itself is tested in scripts/lib/rate-limit.test.mjs.
// Run: node --test "skills/ship-dag/scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { newestLogFile, readLatestUtilization } from './rate-limit-preflight.mjs';

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
