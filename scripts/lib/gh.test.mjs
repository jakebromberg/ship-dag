// gh.test.mjs — ghFailure classifies a failed gh call from its structured output, not by reading its wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ghFailure, ghJson } from './gh.mjs';

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
    ['stdout that is not JSON', failed('Command failed: gh api', { stdout: '<html>Bad Gateway</html>', stderr: 'gh: Bad Gateway (HTTP 502)' }), { status: 502, rateLimited: false }],
  ];
  for (const [name, err, want] of table) assert.deepEqual(ghFailure(err), want, name);
});

test('ghJson: the value, or the classified failure after a warning with the caller\'s prefix', async () => {
  const warns = [];
  const ctx = { repo: 'o/r', sleep: async () => {}, warn: (m) => warns.push(m), prefix: 'pfx' };
  assert.deepEqual(await ghJson(['x'], 'what', { ...ctx, gh: async () => '[1]' }), { value: [1] });
  const bad = failed('gh: nope (HTTP 422)');
  assert.deepEqual(await ghJson(['x'], 'what', { ...ctx, gh: async () => { throw bad; } }), { failure: { status: 422, rateLimited: false } });
  assert.deepEqual(warns, ['pfx: what: gh: nope (HTTP 422)']);
});
