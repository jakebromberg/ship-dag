// Tests for the one matcher every reader of review round files shares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { reviewRoundFiles, isUnreadableEmpty } from './review-rounds.mjs';

const REF = 'o/r#12';
const STEM = 'o%2Fr%2312';

function reviewsDir(names) {
  const dir = mkdtempSync(join(tmpdir(), 'rounds-'));
  mkdirSync(join(dir, 'passes'));
  for (const n of names) writeFileSync(join(dir, n), '{}');
  return dir;
}

test('reviewRoundFiles keeps every naming form a round has used, and nothing else', () => {
  const dir = reviewsDir([
    `${STEM}.json`, `${STEM}.r2.json`, `${STEM}-r3.json`, `${STEM}.iter1.json`, `${STEM}.pass3-skills.json`,
    `${STEM}.json.raw`, 'o%2Fr%23123.json', 'o%2Fr%231.json', `${STEM}.r2.json.raw`, `passes/${STEM}.1.verify.json`,
  ]);
  writeFileSync(join(dir, 'passes', `${STEM}.1.verify.json`), '{}');
  assert.deepEqual(reviewRoundFiles([dir], REF).map((f) => basename(f.path)).sort(), [
    `${STEM}-r3.json`, `${STEM}.iter1.json`, `${STEM}.json`, `${STEM}.pass3-skills.json`, `${STEM}.r2.json`,
  ]);
});

test('reviewRoundFiles reads across dirs, oldest first, and skips a dir that does not exist', () => {
  const a = reviewsDir([`${STEM}.json`]);
  const b = reviewsDir([`${STEM}.r2.json`]);
  const files = reviewRoundFiles([a, join(a, 'missing'), b], REF);
  assert.equal(files.length, 2);
  assert.ok(files[0].mtimeMs <= files[1].mtimeMs);
});

for (const [name, review, rawSibling, want] of [
  ['empty findings beside a .raw sibling', { findings: [] }, true, true],
  ['empty findings, no sibling', { findings: [] }, false, false],
  ['findings present beside a .raw sibling', { findings: [{}] }, true, false],
]) {
  test(`isUnreadableEmpty: ${name} → ${want}`, () => {
    const dir = reviewsDir(rawSibling ? [`${STEM}.json.raw`] : []);
    assert.equal(isUnreadableEmpty(join(dir, `${STEM}.json`), review), want);
  });
}
