// gh.test.mjs — ghFailure classifies a failed gh call from its structured output, not by reading its wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ghErrorBody, ghFailure, ghJson, withBackoff } from './gh.mjs';

const failed = (message, extra = {}) => Object.assign(new Error(message), extra);
const apiBody = (status, message) => JSON.stringify({ message, status: String(status) });

test('ghFailure: the HTTP status and whether it is a rate limit', () => {
  const table = [
    ['a gh api 422', failed('Command failed: gh api', { stdout: apiBody(422, 'No commit found for SHA: deadbeef'), stderr: 'gh: No commit found for SHA: deadbeef (HTTP 422)' }), { status: 422, rateLimited: false }],
    ['a 403 rate-limit body', failed('Command failed: gh api', { stdout: apiBody(403, 'API rate limit exceeded for user'), stderr: 'gh: API rate limit exceeded (HTTP 403)' }), { status: 403, rateLimited: true }],
    ['a 403 that is not a rate limit', failed('Command failed: gh api', { stdout: apiBody(403, 'Resource not accessible'), stderr: 'gh: Resource not accessible (HTTP 403)' }), { status: 403, rateLimited: false }],
    ['a 429', failed('Command failed: gh api', { stdout: apiBody(429, 'Too many requests'), stderr: 'gh: Too many requests (HTTP 429)' }), { status: 429, rateLimited: true }],
    ['a gh search rate limit, no stdout', failed('Command failed: gh search prs', { stdout: '', stderr: 'gh: API rate limit exceeded' }), { status: null, rateLimited: true }],
    ['a 502', failed('Command failed: gh api', { stdout: apiBody(502, 'Bad Gateway'), stderr: 'gh: Bad Gateway (HTTP 502)' }), { status: 502, rateLimited: false }],
    ['a 502 with only the message', failed('HTTP 502: Bad Gateway'), { status: 502, rateLimited: false }],
    ['a network error, no stdout or stderr', failed('connect ECONNREFUSED', { stdout: '', stderr: '' }), { status: null, rateLimited: false }],
    // stderr names no status: only the JSON body gh api prints on stdout says what the failure was.
    ['a status only in the stdout body', failed('Command failed: gh api', { stdout: apiBody(422, 'No commit found for SHA: deadbeef'), stderr: 'gh: request failed' }), { status: 422, rateLimited: false }],
    ['a rate limit only in the stdout body', failed('Command failed: gh api', { stdout: apiBody(403, 'API rate limit exceeded for user'), stderr: 'gh: request failed' }), { status: 403, rateLimited: true }],
    ['stdout that is not JSON', failed('Command failed: gh api', { stdout: '<html>Bad Gateway</html>', stderr: 'gh: Bad Gateway (HTTP 502)' }), { status: 502, rateLimited: false }],
  ];
  for (const [name, err, want] of table) assert.deepEqual(ghFailure(err), want, name);
});

test('ghErrorBody: a failed call\'s stdout parsed as JSON, or null', () => {
  const notFound = { errors: [{ type: 'NOT_FOUND', path: ['repository', 'issue'], message: 'Could not resolve' }], data: { repository: null } };
  const forbidden = { errors: [{ type: 'FORBIDDEN', path: ['repository', 'issue', 'subIssues', 'nodes', 0], message: 'no access' }], data: null };
  const table = [
    ['a GraphQL NOT_FOUND body', failed('x', { stdout: JSON.stringify(notFound) }), notFound],
    ['a GraphQL FORBIDDEN body with a path', failed('x', { stdout: JSON.stringify(forbidden) }), forbidden],
    ['a REST body', failed('x', { stdout: apiBody(422, 'Unprocessable') }), { message: 'Unprocessable', status: '422' }],
    ['stdout that is not JSON', failed('x', { stdout: '<html>Bad Gateway</html>' }), null],
    ['empty stdout', failed('x', { stdout: '' }), null],
    ['no stdout', failed('x'), null],
    ['no error', undefined, null],
  ];
  for (const [name, err, want] of table) assert.deepEqual(ghErrorBody(err), want, name);
});

test('ghJson: the value, or the classified failure after a warning with the caller\'s prefix', async () => {
  const warns = [];
  const ctx = { repo: 'o/r', sleep: async () => {}, warn: (m) => warns.push(m), prefix: 'pfx' };
  assert.deepEqual(await ghJson(['x'], 'what', { ...ctx, gh: async () => '[1]' }), { value: [1] });
  const bad = failed('gh: nope (HTTP 422)');
  assert.deepEqual(await ghJson(['x'], 'what', { ...ctx, gh: async () => { throw bad; } }), { failure: { status: 422, rateLimited: false } });
  assert.deepEqual(warns, ['pfx: what: gh: nope (HTTP 422)']);
});

test('withBackoff retries on ghFailure\'s classification, not on the message, and ghJson rethrows the exhausted rate limit unwarned', async () => {
  // A 429 whose message never says "rate limit": only the classification marks it as one.
  const limited = () => failed('Command failed: gh api', { stdout: apiBody(429, 'Too many requests'), stderr: 'gh: Too many requests (HTTP 429)' });
  let calls = 0;
  const flaky = async () => { calls += 1; if (calls < 3) throw limited(); return 'ok'; };
  assert.equal(await withBackoff(flaky, { repo: 'o/r', sleep: async () => {} }), 'ok');
  const warns = [];
  const ctx = { repo: 'o/r', sleep: async () => {}, warn: (m) => warns.push(m), prefix: 'pfx' };
  await assert.rejects(ghJson(['x'], 'what', { ...ctx, gh: async () => { throw limited(); } }));
  assert.deepEqual(warns, []);
});
