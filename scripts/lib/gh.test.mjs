// gh.test.mjs — ghFailure classifies a failed gh call from its structured output, not by reading its wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ghErrorBody, ghFailure, ghJson, withBackoff } from './gh.mjs';
import { ghExecError, graphqlAnswer, notFoundBody, restFailure } from './gh-fixture.mjs';

const args = ['api', 'x'];
const apiBody = (status, message) => JSON.stringify({ message, status: String(status) });

test('ghFailure: the HTTP status and whether it is a rate limit', () => {
  const table = [
    ['a gh api 422', restFailure(422, 'No commit found for SHA: deadbeef'), { status: 422, rateLimited: false }],
    ['a 403 rate-limit body', restFailure(403, 'API rate limit exceeded for user'), { status: 403, rateLimited: true }],
    ['a 403 that is not a rate limit', restFailure(403, 'Resource not accessible'), { status: 403, rateLimited: false }],
    ['a 429', restFailure(429, 'Too many requests'), { status: 429, rateLimited: true }],
    ['a gh search rate limit, no stdout', ghExecError(['search', 'prs'], { stderr: 'gh: API rate limit exceeded' }), { status: null, rateLimited: true }],
    ['a 502', restFailure(502, 'Bad Gateway'), { status: 502, rateLimited: false }],
    ['a 502 with only the message', ghExecError(args, { stderr: null, message: 'HTTP 502: Bad Gateway' }), { status: 502, rateLimited: false }],
    ['a network error, no stdout or stderr', ghExecError(args, { message: 'connect ECONNREFUSED' }), { status: null, rateLimited: false }],
    // stderr names no status: only the JSON body gh api prints on stdout says what the failure was.
    ['a status only in the stdout body', ghExecError(args, { stdout: apiBody(422, 'No commit found for SHA: deadbeef'), stderr: 'gh: request failed' }), { status: 422, rateLimited: false }],
    ['a rate limit only in the stdout body', ghExecError(args, { stdout: apiBody(403, 'API rate limit exceeded for user'), stderr: 'gh: request failed' }), { status: 403, rateLimited: true }],
    ['stdout that is not JSON', ghExecError(args, { stdout: '<html>Bad Gateway</html>', stderr: 'gh: Bad Gateway (HTTP 502)' }), { status: 502, rateLimited: false }],
  ];
  for (const [name, err, want] of table) assert.deepEqual(ghFailure(err), want, name);
});

test('ghErrorBody: a failed call\'s stdout parsed as JSON, or null', () => {
  const notFound = { errors: [{ type: 'NOT_FOUND', path: ['repository', 'issue'], message: 'Could not resolve' }], data: { repository: null } };
  const forbidden = { errors: [{ type: 'FORBIDDEN', path: ['repository', 'issue', 'subIssues', 'nodes', 0], message: 'no access' }], data: null };
  const table = [
    ['a GraphQL NOT_FOUND body', ghExecError(args, { stdout: JSON.stringify(notFound) }), notFound],
    ['a GraphQL FORBIDDEN body with a path', ghExecError(args, { stdout: JSON.stringify(forbidden) }), forbidden],
    ['a REST body', ghExecError(args, { stdout: apiBody(422, 'Unprocessable') }), { message: 'Unprocessable', status: '422' }],
    ['stdout that is not JSON', ghExecError(args, { stdout: '<html>Bad Gateway</html>' }), null],
    ['empty stdout', ghExecError(args), null],
    ['no stdout', Object.create(null), null],
    ['no error', undefined, null],
  ];
  for (const [name, err, want] of table) assert.deepEqual(ghErrorBody(err), want, name);
});

test('the gh-fixture builders are read by ghFailure and ghErrorBody as real gh failures are', () => {
  const graphql = (() => { try { return graphqlAnswer(notFoundBody(999999)); } catch (e) { return e; } })();
  const table = [
    ['REST 404', restFailure(404, 'Not Found'), 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest', status: '404' }],
    ['REST 422', restFailure(422, 'Unprocessable Entity'), 422, { message: 'Unprocessable Entity', documentation_url: 'https://docs.github.com/rest', status: '422' }],
    ['REST 502', restFailure(502, 'Bad Gateway'), 502, { message: 'Bad Gateway', documentation_url: 'https://docs.github.com/rest', status: '502' }],
    ['GraphQL NOT_FOUND', graphql, null, notFoundBody(999999)],
  ];
  for (const [name, err, status, body] of table) {
    assert.deepEqual(ghFailure(err), { status, rateLimited: false }, name);
    assert.deepEqual(ghErrorBody(err), body, name);
  }
  assert.equal(graphqlAnswer({ data: { x: 1 } }), '{"data":{"x":1}}');
});

test('ghJson: the value, or the classified failure after a warning with the caller\'s prefix', async () => {
  const warns = [];
  const ctx = { repo: 'o/r', sleep: async () => {}, warn: (m) => warns.push(m), prefix: 'pfx' };
  assert.deepEqual(await ghJson(['x'], 'what', { ...ctx, gh: async () => '[1]' }), { value: [1] });
  const bad = ghExecError(args, { stderr: 'gh: nope (HTTP 422)', message: 'gh: nope (HTTP 422)' });
  assert.deepEqual(await ghJson(['x'], 'what', { ...ctx, gh: async () => { throw bad; } }), { failure: { status: 422, rateLimited: false } });
  assert.deepEqual(warns, ['pfx: what: gh: nope (HTTP 422)']);
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
