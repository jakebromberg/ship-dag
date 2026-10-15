// Tests for sub-issues.mjs. Run: node --test "scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listSubIssues, SubIssuesUnavailable, hasSubIssues } from './sub-issues.mjs';
import { ghExecError, graphqlAnswer, graphqlFailure, notFoundBody, restFailure } from './gh-fixture.mjs';

const epic = { repo: 'o/2048', number: 7 };
const page = (nodes, pageInfo) => JSON.stringify({ data: { repository: { issue: { subIssues: { nodes, pageInfo } } } } });
const last = { hasNextPage: false, endCursor: null };
const more = { hasNextPage: true, endCursor: 'c1' };
const notFound = notFoundBody(7).errors[0];
const noIssue = (errors) => ({ data: { repository: { issue: null } }, errors });

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
  assert.equal(calls[1][calls[1].indexOf('cursor=c1') - 1], '-f'); // a String: -F would retype an all-digit cursor
});

test('a runGh failure propagates unchanged, on any page', () => {
  const failures = [
    ['no body', ghExecError(['api', 'graphql'], { stderr: 'gh: Bad Gateway (HTTP 502)\n' })],
    ['a REST error body', restFailure(502, 'Bad Gateway', ['api', 'graphql'])],
    ['a body that is not JSON', ghExecError(['api', 'graphql'], { stdout: '<html>502 Bad Gateway</html>', stderr: 'gh: HTTP 502\n' })],
    ['a rate limit', graphqlFailure({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] })],
    ['NOT_FOUND alongside another error', graphqlFailure(noIssue([notFound, { type: 'FORBIDDEN' }]))],
    ['NOT_FOUND with the connection present', graphqlFailure({ ...JSON.parse(page([], last)), errors: [notFound] })],
  ];
  for (const [name, err] of failures) {
    for (const responses of [[throws(err)], [page([{ number: 1 }], more), throws(err)]]) {
      assert.throws(() => listSubIssues(epic, fake(responses).runGh), (e) => e === err, `${name}, page ${responses.length}`);
    }
  }
  // A NOT_FOUND exit after the first page: the epic is half read, so it is not a missing connection.
  const gone = graphqlFailure(noIssue([notFound]));
  assert.throws(() => listSubIssues(epic, fake([page([{ number: 1 }], more), throws(gone)]).runGh), (e) => e === gone);
});

test('a listing with sub-issues the token cannot read is a plain Error naming them, never a drop', () => {
  const at = (...rest) => ['repository', 'issue', 'subIssues', 'nodes', ...rest];
  const sso = { type: 'FORBIDDEN', message: 'Resource protected by organization SAML enforcement.' };
  const listing = (nodes, errors) => graphqlFailure({ data: { repository: { issue: { subIssues: { nodes, pageInfo: last } } } }, errors });
  const cases = [
    ['a null node, by position and message', [], listing([{ number: 1 }, null], [{ ...sso, path: at(1) }]),
      /^listSubIssues: 1 sub-issue of o\/2048#7 could not be read: sub-issue 2 \(FORBIDDEN: Resource protected by organization SAML enforcement\.\)$/],
    ['a node whose repo is unreadable, by number', [], listing([{ number: 3, repository: null }],
      [{ type: 'NOT_FOUND', path: at(0, 'repository'), message: "Could not resolve to a Repository with the name 'other/private'." }]),
      /: #3 \(NOT_FOUND: Could not resolve to a Repository with the name 'other\/private'\.\)$/],
    ['a named node and a count of the rest', [], listing([null, null], [{ ...sso, path: at(0) }]),
      /2 sub-issues of o\/2048#7 could not be read: sub-issue 1 \(FORBIDDEN: [^)]*\), and 1 more$/],
    ['no error names them: a count', [], listing([null, null], [sso]), /: 2 sub-issues of o\/2048#7 could not be read$/],
    ['on a later page, by position in the whole listing', [page([{ number: 1 }], more)], listing([null], [{ ...sso, path: at(0) }]),
      /could not be read: sub-issue 2 \(FORBIDDEN/],
  ];
  for (const [name, before, err, re] of cases) {
    assert.throws(() => listSubIssues(epic, fake([...before, throws(err)]).runGh), (e) => plain(re)(e) && e.cause === err, name);
  }
});

test('a first page with no sub-issues connection is SubIssuesUnavailable, whether gh exits 0 or on NOT_FOUND', () => {
  const cases = [
    ['exit 0, no issue', '{"data":{"repository":{"issue":null}}}'],
    ['exit 0, only errors', '{"errors":[{"message":"x"}]}'],
    ['gh NOT_FOUND exit, no issue', throws(graphqlFailure(noIssue([notFound])))],
    ['gh NOT_FOUND exit, no repo', throws(graphqlFailure({ data: { repository: null }, errors: [{ ...notFound, path: ['repository'] }] }))],
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
    ['a later page with no connection', [page([{ number: 1 }], more), graphqlAnswer(noIssue())], /no sub-issues connection on a later page/],
    ['a missing pageInfo', [page([], undefined)], /malformed pageInfo/],
    ['a null cursor with more pages', [page([], { hasNextPage: true, endCursor: null })], /malformed pageInfo/],
    ['a null nodes list', [page(null, last)], /malformed nodes/],
    ['a null node', [page([{ number: 1 }, null], last)], /malformed nodes/],
  ];
  for (const [name, responses, re] of cases) {
    assert.throws(() => listSubIssues(epic, fake(responses).runGh), plain(re), name);
  }
});

test('a malformed repo throws before any gh call', () => {
  for (const repo of ['nope', 'a/b/c', 'o/r#5', '', undefined]) {
    const { runGh, calls } = fake([page([], last)]);
    assert.throws(() => listSubIssues({ repo, number: 1 }, runGh), plain(/repo must be owner\/repo/), String(repo));
    assert.equal(calls.length, 0);
  }
});

for (const [node, want] of [
  [{ subIssuesSummary: { total: 2 } }, true],
  [{ subIssuesSummary: { total: 0 } }, false],
  [{}, false],
  [null, false],
]) {
  test(`hasSubIssues(${JSON.stringify(node)}) is ${want}`, () => assert.equal(hasSubIssues(node), want));
}
