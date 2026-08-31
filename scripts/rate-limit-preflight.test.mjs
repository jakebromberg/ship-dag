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

const event = (utilization, resetsAt, status = 'allowed') =>
  `${JSON.stringify({ type: 'rate_limit_event', status, unifiedWindows: { five_hour: { utilization, resetsAt } } })}\n`;

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
    const older = writeLog(dir, 'run-a', 'o-r-1', event(0.5, '2026-08-31T20:00:00Z'), new Date('2026-08-31T20:00:00Z'));
    const newer = writeLog(dir, 'run-b', 'o-r-2', event(0.9, '2026-08-31T23:00:00Z'), new Date('2026-08-31T22:00:00Z'));
    assert.equal(newestLogFile(dir), newer);
    assert.notEqual(newestLogFile(dir), older);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLatestUtilization: reads the newest event from the newest log file', () => {
  const dir = tmpBase();
  try {
    writeLog(dir, 'run-a', 'o-r-1', event(0.5, '2026-08-31T20:00:00Z'), new Date('2026-08-31T20:00:00Z'));
    writeLog(dir, 'run-b', 'o-r-2', event(0.3, '2026-08-31T21:00:00Z') + event(0.91, '2026-08-31T23:30:00Z'), new Date('2026-08-31T22:00:00Z'));
    const result = readLatestUtilization(dir);
    assert.equal(result.utilization, 0.91);
    assert.equal(result.resetsAt, '2026-08-31T23:30:00Z');
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
