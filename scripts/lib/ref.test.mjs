// Tests for ref.mjs. Run: node --test "scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REF_RE, parseRef, formatRef, isPr, refKey, sameRepo } from './ref.mjs';

test('parseRef reads owner/repo#N and nothing else', () => {
  for (const [input, want] of [
    ['o/r#1', { repo: 'o/r', number: 1 }],
    ['o/r#12', { repo: 'o/r', number: 12 }],
    ['o/r.js#3', { repo: 'o/r.js', number: 3 }],
    ['r#1', null], // no owner
    ['/r#1', null],
    ['o/r#s#1', null], // a # in the repo
    ['o/r#1 ', null], // trailing space
    [' o/r#1', null], // leading space
    ['o /r#1', null], // a space in the owner
    ['o/r/x#1', null], // a second slash: GitHub names one owner and one repo
    ['o/r#', null],
    ['o/r#1.5', null],
    [undefined, null],
    [7, null],
  ]) assert.deepEqual(parseRef(input), want, JSON.stringify(input));
  assert.equal(REF_RE.test('o/r#1'), true);
});

test('formatRef builds what parseRef reads', () => {
  assert.equal(formatRef('o/r', 12), 'o/r#12');
  assert.deepEqual(parseRef(formatRef('o/r', 12)), { repo: 'o/r', number: 12 });
});

test('isPr accepts positive integers only', () => {
  for (const [input, want] of [[1, true], [4096, true], [0, false], [-1, false], [1.5, false], ['7', false], [null, false], [undefined, false], [NaN, false], [Infinity, false]]) {
    assert.equal(isPr(input), want, String(input));
  }
});

test('sameRepo folds case, and refKey keys repos and refs by the same fold', () => {
  for (const [a, b, want] of [['o/r', 'o/r', true], ['O/R', 'o/r', true], ['o/r', 'o/r2', false], ['o/r', 'p/r', false], ['O/R#1', 'o/r#1', true]]) {
    assert.equal(sameRepo(a, b), want, `${a} ${b}`);
    assert.equal(refKey(a) === refKey(b), want, `${a} ${b}`);
  }
  assert.equal(refKey(7), '7');
});
