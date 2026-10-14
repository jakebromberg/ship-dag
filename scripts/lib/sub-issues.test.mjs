// Tests for sub-issues.mjs. Run: node --test "scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listSubIssues, SubIssuesUnavailable } from './sub-issues.mjs';

const epic = { repo: 'o/2048', number: 7 };
const page = (nodes, pageInfo) => JSON.stringify({ data: { repository: { issue: { subIssues: { nodes, pageInfo } } } } });
const last = { hasNextPage: false, endCursor: null };

// A runGh fake that answers from `responses` in order (a function entry throws or returns).
function fake(responses) {
  const calls = [];
  const runGh = (argv) => {
    calls.push(argv);
    const r = responses[calls.length - 1];
    return typeof r === 'function' ? r() : r;
  };
  return { runGh, calls };
}

test('owner and name go through -f so an all-digit name stays a string; n stays -F', () => {
  const { runGh, calls } = fake([page([], last)]);
  listSubIssues({ repo: '123/2048', number: 7 }, runGh);
  const argv = calls[0];
  assert.deepEqual(argv.slice(argv.indexOf('owner=123') - 1, argv.indexOf('owner=123') + 1), ['-f', 'owner=123']);
  assert.equal(argv[argv.indexOf('name=2048') - 1], '-f');
  assert.equal(argv[argv.indexOf('n=7') - 1], '-F');
});

test('follows cursors across pages', () => {
  const { runGh, calls } = fake([
    page([{ number: 1 }], { hasNextPage: true, endCursor: 'c1' }),
    page([{ number: 2 }], last),
  ]);
  assert.deepEqual(listSubIssues(epic, runGh).map((n) => n.number), [1, 2]);
  assert.ok(calls[1].includes('cursor=c1'));
});

test('a runGh failure propagates unchanged, on any page', () => {
  const boom = new Error('HTTP 502');
  for (const responses of [
    [() => { throw boom; }],
    [page([{ number: 1 }], { hasNextPage: true, endCursor: 'c1' }), () => { throw boom; }],
  ]) {
    assert.throws(() => listSubIssues(epic, fake(responses).runGh), (e) => e === boom);
  }
});

test('a missing connection or unparseable body is SubIssuesUnavailable', () => {
  for (const body of ['{"data":{"repository":{"issue":null}}}', '{"errors":[{"message":"x"}]}', 'not json']) {
    assert.throws(() => listSubIssues(epic, fake([body]).runGh), SubIssuesUnavailable);
  }
});

test('a missing pageInfo or a null cursor with more pages is a plain Error', () => {
  for (const body of [page([], undefined), page([], { hasNextPage: true, endCursor: null })]) {
    assert.throws(() => listSubIssues(epic, fake([body]).runGh),
      (e) => e instanceof Error && !(e instanceof SubIssuesUnavailable));
  }
});

test('a malformed repo throws before any gh call', () => {
  for (const repo of ['nope', 'a/b/c', '', undefined]) {
    const { runGh, calls } = fake([page([], last)]);
    assert.throws(() => listSubIssues({ repo, number: 1 }, runGh),
      (e) => e instanceof Error && !(e instanceof SubIssuesUnavailable));
    assert.equal(calls.length, 0);
  }
});
