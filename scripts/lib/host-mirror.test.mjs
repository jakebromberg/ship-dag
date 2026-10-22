// Tests for the host-mirror record: its merge rule and its atomic read and write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIRROR_FILE, mirrorRecord, readMirror, writeMirror } from './host-mirror.mjs';

for (const [name, prev, ok, expected] of [
  ['a read', null, true, { host: 'box', readAt: 'T2' }],
  ['a read after a failure clears it', { host: 'box', readAt: 'T1', unreachableAt: 'T1b' }, true, { host: 'box', readAt: 'T2' }],
  ['a failure keeps the last read', { host: 'box', readAt: 'T1' }, false, { host: 'box', readAt: 'T1', unreachableAt: 'T2' }],
  ['a failure with no read yet', null, false, { host: 'box', readAt: null, unreachableAt: 'T2' }],
  ['a failure after another host\'s record keeps none of it', { host: 'other', readAt: 'T1' }, false, { host: 'box', readAt: null, unreachableAt: 'T2' }],
]) {
  test(`mirrorRecord: ${name}`, () => {
    assert.deepEqual(mirrorRecord(prev, 'box', ok, 'T2'), expected);
  });
}

test('writeMirror merges with the record already there and leaves no temp file; readMirror reads it back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-mirror-'));
  writeMirror(dir, 'box', true, 'T1');
  writeMirror(dir, 'box', false, 'T2');
  assert.deepEqual(readMirror(dir), { host: 'box', readAt: 'T1', unreachableAt: 'T2' });
  assert.deepEqual(readdirSync(dir), [MIRROR_FILE]);
});

test('readMirror: an absent or torn record reads as none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-mirror-'));
  assert.equal(readMirror(dir), null);
  writeFileSync(join(dir, MIRROR_FILE), '{"host":');
  assert.equal(readMirror(dir), null);
});
