// Tests for the one matcher every reader of review round files shares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
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

// A copy that does not keep mtimes must not reorder rounds SKILL.md names, so `.json`, `.rN` and `-rN` are ordered by
// their round number. A set holding any other (legacy) tag keeps mtime order, as does a tie on the number.
for (const [what, names, want] of [
  ['SKILL.md names, by round number, not mtime or spelling', ['.r10', '-r3', '.r2', ''], ['', '.r2', '-r3', '.r10']],
  ['a legacy tag among them, by mtime', ['.r2', '.regate', ''], ['.r2', '.regate', '']],
]) {
  test(`reviewRoundFiles orders ${what}`, () => {
    const dir = reviewsDir([]);
    names.forEach((tag, i) => {
      writeFileSync(join(dir, `${STEM}${tag}.json`), '{}');
      utimesSync(join(dir, `${STEM}${tag}.json`), 1_000 + i, 1_000 + i);
    });
    assert.deepEqual(reviewRoundFiles([dir], REF).map((f) => basename(f.path)), want.map((t) => `${STEM}${t}.json`));
  });
}

test('reviewRoundFiles orders the same round number in two dirs by mtime', () => {
  const [a, b] = [reviewsDir([`${STEM}.json`]), reviewsDir([`${STEM}.json`, `${STEM}.r2.json`])];
  utimesSync(join(a, `${STEM}.json`), 2_000, 2_000);
  utimesSync(join(b, `${STEM}.json`), 1_000, 1_000);
  utimesSync(join(b, `${STEM}.r2.json`), 500, 500);
  assert.deepEqual(reviewRoundFiles([a, b], REF).map((f) => f.path), [join(b, `${STEM}.json`), join(a, `${STEM}.json`), join(b, `${STEM}.r2.json`)]);
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
