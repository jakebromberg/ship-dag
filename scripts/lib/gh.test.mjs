// gh.test.mjs — ghFailure classifies a failed gh call from its structured output, not by reading its wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ghErrorBody, ghFailure, ghJson, ghNotFound, withBackoff } from './gh.mjs';
import { ghExecError, ghMissing, graphqlAnswer, graphqlFailure, issueViewNotFound, notFoundBody, restFailure } from './gh-fixture.mjs';

const args = ['api', 'x'];

test('ghFailure: the HTTP status and whether it is a rate limit', () => {
  const table = [
    ['a gh api 422', restFailure(422, 'No commit found for SHA: deadbeef'), { status: 422, rateLimited: false }],
    ['a 403 rate-limit body', restFailure(403, 'API rate limit exceeded for user'), { status: 403, rateLimited: true }],
    ['a 403 that is not a rate limit', restFailure(403, 'Resource not accessible'), { status: 403, rateLimited: false }],
    ['a 429', restFailure(429, 'Too many requests'), { status: 429, rateLimited: true }],
    ['a gh search rate limit, no stdout', ghExecError(['search', 'prs'], { stderr: 'gh: API rate limit exceeded' }), { status: null, rateLimited: true }],
    ['a 502', restFailure(502, 'Bad Gateway'), { status: 502, rateLimited: false }],
    ['a 502 with only the message', ghExecError(args, { stderr: null, message: 'HTTP 502: Bad Gateway' }), { status: 502, rateLimited: false }],
    ['a network error, no stdout or stderr', ghExecError(args, { stderr: null, message: 'connect ECONNREFUSED' }), { status: null, rateLimited: false }],
    // stderr names no status: only the JSON body gh api prints on stdout says what the failure was.
    ['a status only in the stdout body', ghExecError(args, { stdout: restFailure(422, 'No commit found for SHA: deadbeef').stdout, stderr: 'gh: request failed' }), { status: 422, rateLimited: false }],
    ['a rate limit only in the stdout body', ghExecError(args, { stdout: restFailure(403, 'API rate limit exceeded for user').stdout, stderr: 'gh: request failed' }), { status: 403, rateLimited: true }],
    ['stdout that is not JSON', ghExecError(args, { stdout: '<html>Bad Gateway</html>', stderr: 'gh: Bad Gateway (HTTP 502)' }), { status: 502, rateLimited: false }],
  ];
  for (const [name, err, want] of table) assert.deepEqual(ghFailure(err), want, name);
});

test('ghErrorBody: a failed call\'s stdout parsed as JSON, or null', () => {
  // The fixture table below covers the recorded REST and GraphQL NOT_FOUND bodies.
  const forbidden = { errors: [{ type: 'FORBIDDEN', path: ['repository', 'issue', 'subIssues', 'nodes', 0], message: 'no access' }], data: null };
  const table = [
    ['a GraphQL FORBIDDEN body with a path', ghExecError(args, { stdout: JSON.stringify(forbidden) }), forbidden],
    ['stdout that is not JSON', ghExecError(args, { stdout: '<html>Bad Gateway</html>' }), null],
    ['empty stdout', ghExecError(args), null],
    ['no stdout: no gh to run', ghMissing(args), null],
    ['no error', undefined, null],
  ];
  for (const [name, err, want] of table) assert.deepEqual(ghErrorBody(err), want, name);
});

test('ghNotFound: true only when every GraphQL error is NOT_FOUND', () => {
  const mixed = { data: null, errors: [{ type: 'NOT_FOUND', message: 'gone' }, { type: 'FORBIDDEN', message: 'no access' }] };
  const table = [
    ['every error NOT_FOUND', graphqlFailure(notFoundBody(9)), true],
    ['NOT_FOUND mixed with FORBIDDEN', graphqlFailure(mixed), false],
    ['a REST 404 body with no errors', restFailure(404, 'Not Found'), false],
    ['stdout that is not JSON', ghExecError(args, { stdout: '<html>Bad Gateway</html>' }), false],
    ['no stdout', ghMissing(args), false],
    ['an empty errors list', ghExecError(args, { stdout: JSON.stringify({ errors: [] }) }), false],
  ];
  for (const [name, err, want] of table) assert.equal(ghNotFound(err), want, name);
});

test('the gh-fixture builders are read by ghFailure and ghErrorBody as real gh failures are', () => {
  const missing = 'Could not resolve to an Issue with the number of 999999.';
  const table = [
    ['REST 404', restFailure(404, 'Not Found'), 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest', status: '404' }, 'gh: Not Found (HTTP 404)\n'],
    ['REST 422', restFailure(422, 'Unprocessable Entity'), 422, { message: 'Unprocessable Entity', documentation_url: 'https://docs.github.com/rest', status: '422' }, 'gh: Unprocessable Entity (HTTP 422)\n'],
    ['REST 502', restFailure(502, 'Bad Gateway'), 502, { message: 'Bad Gateway', documentation_url: 'https://docs.github.com/rest', status: '502' }, 'gh: Bad Gateway (HTTP 502)\n'],
    ['GraphQL NOT_FOUND', graphqlFailure(notFoundBody(999999)), null,
      { data: { repository: { issue: null } }, errors: [{ type: 'NOT_FOUND', path: ['repository', 'issue'], locations: [{ line: 1, column: 1 }], message: missing }] }, `gh: ${missing}\n`],
    ['issue view of a missing issue', issueViewNotFound(999999), null, null,
      'GraphQL: Could not resolve to an issue or pull request with the number of 999999. (repository.issue)\n'],
    ['no gh to run', ghMissing(args), null, null, undefined],
  ];
  for (const [name, err, status, body, stderr] of table) {
    assert.deepEqual(ghFailure(err), { status, rateLimited: false }, name);
    assert.deepEqual(ghErrorBody(err), body, name);
    assert.equal(err.stderr, stderr, name);
  }
  // Node adds `\n<stderr>` to the message only when there is stderr.
  assert.equal(ghExecError(args).message, 'Command failed: gh api x');
  assert.equal(issueViewNotFound(7, ['issue', 'view', '7']).message,
    'Command failed: gh issue view 7\nGraphQL: Could not resolve to an issue or pull request with the number of 7. (repository.issue)\n');
  const spawn = ghMissing(args);
  assert.deepEqual([spawn.code, spawn.status, spawn.message, spawn.stdout], ['ENOENT', null, 'spawnSync gh ENOENT', undefined]);
});

test('graphqlAnswer exits 1 exactly when gh 2.102.0\'s parseErrorResponse finds error text in the body, and prints it as gh does', () => {
  const table = [
    ['no errors', { data: { x: 1 } }, null],
    ['an empty list', { data: null, errors: [] }, null],
    ['no message at all', { data: null, errors: [{ type: 'FORBIDDEN' }] }, null],
    ['every message, one per line; one with none repeats the one before', { data: null, errors: [{ type: 'NOT_FOUND', message: 'No issue.' }, { type: 'FORBIDDEN' }, { message: 'No PR.' }] }, 'gh: No issue.\nNo issue.\nNo PR.\n'],
    ['a string entry as it is; a null skipped', { errors: [{ message: 'a' }, null, 'b', {}] }, 'gh: a\nb\na\n'],
    ['errors that is a string', { errors: 'denied' }, 'gh: denied\n'],
    ['a top-level message', { message: 'Bad credentials' }, 'gh: Bad credentials (HTTP 200)\n'],
  ];
  for (const [name, body, stderr] of table) {
    if (stderr === null) {
      assert.equal(graphqlAnswer(body), JSON.stringify(body), name);
      assert.throws(() => graphqlFailure(body), /gh exits 0 on this body/, name);
    } else {
      const err = graphqlFailure(body, ['api', 'graphql']);
      assert.deepEqual([err.status, err.stdout, err.stderr, err.message], [1, JSON.stringify(body), stderr, `Command failed: gh api graphql\n${stderr}`], name);
      assert.throws(() => graphqlAnswer(body), (e) => e.stderr === stderr, name);
    }
  }
});

test('ghJson: the value, or the classified failure after a warning with the caller\'s prefix', async () => {
  const warns = [];
  const ctx = { repo: 'o/r', sleep: async () => {}, warn: (m) => warns.push(m), prefix: 'pfx' };
  assert.deepEqual(await ghJson(['x'], 'what', { ...ctx, gh: async () => '[1]' }), { value: [1] });
  const bad = restFailure(422, 'nope', ['x']);
  assert.deepEqual(await ghJson(['x'], 'what', { ...ctx, gh: async () => { throw bad; } }), { failure: { status: 422, rateLimited: false } });
  assert.deepEqual(warns, ['pfx: what: Command failed: gh x\ngh: nope (HTTP 422)\n']);
});

test('withBackoff retries on ghFailure\'s classification, not on the message, and ghJson rethrows the exhausted rate limit unwarned', async () => {
  // A 429 whose message never says "rate limit": only the classification marks it as one.
  const limited = () => restFailure(429, 'Too many requests');
  let calls = 0;
  const flaky = async () => { calls += 1; if (calls < 3) throw limited(); return 'ok'; };
  assert.equal(await withBackoff(flaky, { repo: 'o/r', sleep: async () => {} }), 'ok');
  const warns = [];
  const ctx = { repo: 'o/r', sleep: async () => {}, warn: (m) => warns.push(m), prefix: 'pfx' };
  await assert.rejects(ghJson(['x'], 'what', { ...ctx, gh: async () => { throw limited(); } }));
  assert.deepEqual(warns, []);
});
