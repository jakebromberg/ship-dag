// Tests for ref.mjs. Run: node --test "scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REF_RE, REPO_RE, parseRef, formatRef, isPr, refKey, sameRepo, parsePr } from './ref.mjs';

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

test('parsePr reads a PR value as {repo, pr} and nothing else as null', () => {
  for (const [input, want] of [
    [11, { repo: 'o/r', pr: 11 }],
    ['11', { repo: 'o/r', pr: 11 }],
    ['o/r#11', { repo: 'o/r', pr: 11 }],
    ['O/R#11', { repo: 'O/R', pr: 11 }],
    ['x/y#11', { repo: 'x/y', pr: 11 }], // another repo
    ['https://github.com/o/r/pull/11', { repo: 'o/r', pr: 11 }],
    ['https://github.com/o/r/pull/11/', { repo: 'o/r', pr: 11 }],
    ['https://github.com/x/y/pull/11', { repo: 'x/y', pr: 11 }],
    ['HTTPS://GitHub.com/o/r/pull/11', { repo: 'o/r', pr: 11 }], // a URL is read whatever its case
    ['draft-11', null],
    ['https://github.com/o/r/pull/0', null],
    ['https://github.com/o/r/issues/11', null], // an issue is no PR
    ['011', null],
    ['#11', null],
    ['o/r#0', null],
    [0, null],
    [-1, null],
    [null, null],
  ]) assert.deepEqual(parsePr(input, 'o/r'), want, String(input));
});

test('REPO_RE: a bare owner/repo, refusing a ref, a second slash, whitespace or a missing half', () => {
  for (const ok of ['o/r', 'WXYC/dj-site', 'jakebromberg/ship-dag', 'a.b/c_d-e']) assert.equal(REPO_RE.test(ok), true, ok);
  for (const bad of ['o/r#1', 'o/r/x', 'o /r', 'r', '/r', 'o/', '']) assert.equal(REPO_RE.test(bad), false, bad);
});

test('parseRef and REF_RE are the plugin\'s single definitions, re-exported', async () => {
  const plugin = await import('../../plugins/ship-dag-eta/lib/ref.mjs');
  assert.equal(parseRef, plugin.parseRef);
  assert.equal(REF_RE, plugin.REF_RE);
});

test('parseRef: refs that must not parse (ETA parity inputs)', () => {
  for (const input of ['o/r', 'o/r#1x', 'o r#1', '#1', null, ['o/r#1']]) assert.equal(parseRef(input), null, JSON.stringify(input));
  assert.deepEqual(parseRef('O/R#3'), { repo: 'O/R', number: 3 });
  assert.deepEqual(parseRef('a%b/c#2'), { repo: 'a%b/c', number: 2 });
});
