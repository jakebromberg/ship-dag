// Tests for sub-issues.mjs. Run: node --test "scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listSubIssues, SubIssuesUnavailable } from './sub-issues.mjs';

const epic = { repo: 'o/2048', number: 7 };
const page = (nodes, pageInfo) => JSON.stringify({ data: { repository: { issue: { subIssues: { nodes, pageInfo } } } } });
const last = { hasNextPage: false, endCursor: null };
const more = { hasNextPage: true, endCursor: 'c1' };
const notFound = { type: 'NOT_FOUND', message: 'Could not resolve to an Issue with the number of 7.' };
const noIssue = (errors) => JSON.stringify({ data: { repository: { issue: null } }, errors });

// What realRunGh throws when gh exits non-zero; gh exits 1 whenever a GraphQL response carries `errors`.
const ghError = (stdout) => Object.assign(new Error('Command failed: gh api graphql'), { status: 1, stdout });
const throws = (err) => () => { throw err; };

// A plain Error with this message: not SubIssuesUnavailable, and not the TypeError an unguarded read throws.
const plain = (re) => (e) => e.constructor === Error && re.test(e.message);

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
    page([{ number: 1 }], more),
    page([{ number: 2 }], last),
  ]);
  assert.deepEqual(listSubIssues(epic, runGh).map((n) => n.number), [1, 2]);
  assert.ok(calls[1].includes('cursor=c1'));
});

test('a runGh failure propagates unchanged, on any page', () => {
  const failures = [
    ['no body', Object.assign(new Error('HTTP 502'), { stdout: '' })],
    ['a body that is not JSON', ghError('<html>502 Bad Gateway</html>')],
    ['a rate limit', ghError(JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }))],
    ['NOT_FOUND alongside another error', ghError(noIssue([notFound, { type: 'FORBIDDEN' }]))],
    ['NOT_FOUND with the connection present', ghError(JSON.stringify({ ...JSON.parse(page([], last)), errors: [notFound] }))],
  ];
  for (const [name, err] of failures) {
    for (const responses of [[throws(err)], [page([{ number: 1 }], more), throws(err)]]) {
      assert.throws(() => listSubIssues(epic, fake(responses).runGh), (e) => e === err, `${name}, page ${responses.length}`);
    }
  }
  // A NOT_FOUND exit after the first page: the epic is half read, so it is not a missing connection.
  const gone = ghError(noIssue([notFound]));
  assert.throws(() => listSubIssues(epic, fake([page([{ number: 1 }], more), throws(gone)]).runGh), (e) => e === gone);
});

test('a first page with no sub-issues connection is SubIssuesUnavailable, whether gh exits 0 or on NOT_FOUND', () => {
  const cases = [
    ['exit 0, no issue', '{"data":{"repository":{"issue":null}}}'],
    ['exit 0, only errors', '{"errors":[{"message":"x"}]}'],
    ['gh NOT_FOUND exit, no issue', throws(ghError(noIssue([notFound])))],
    ['gh NOT_FOUND exit, no repo', throws(ghError(JSON.stringify({ data: { repository: null }, errors: [{ ...notFound, path: ['repository'] }] })))],
  ];
  for (const [name, response] of cases) {
    assert.throws(() => listSubIssues(epic, fake([response]).runGh),
      (e) => e instanceof SubIssuesUnavailable && /no sub-issues returned/.test(e.message), name);
  }
});

test('an unparseable or malformed page is a plain Error, never SubIssuesUnavailable', () => {
  const cases = [
    ['a first page that is not JSON', ['<html>502 Bad Gateway</html>'], /not JSON/],
    ['a later page that is not JSON', [page([{ number: 1 }], more), '<html>502 Bad Gateway</html>'], /not JSON/],
    ['a later page with no connection', [page([{ number: 1 }], more), noIssue(undefined)], /no sub-issues connection on a later page/],
    ['a missing pageInfo', [page([], undefined)], /malformed pageInfo/],
    ['a null cursor with more pages', [page([], { hasNextPage: true, endCursor: null })], /malformed pageInfo/],
  ];
  for (const [name, responses, re] of cases) {
    assert.throws(() => listSubIssues(epic, fake(responses).runGh), plain(re), name);
  }
});

test('a malformed repo throws before any gh call', () => {
  for (const repo of ['nope', 'a/b/c', '', undefined]) {
    const { runGh, calls } = fake([page([], last)]);
    assert.throws(() => listSubIssues({ repo, number: 1 }, runGh), plain(/repo must be owner\/repo/), String(repo));
    assert.equal(calls.length, 0);
  }
});
