// gh-fixture.mjs — test support (not a test file): what a failed `gh` call throws through `realRunGh`
// (`execFileSync('gh', args, { encoding: 'utf8' })`), so fakes share one shape and `ghFailure` and `ghErrorBody`
// read them as they read real gh. Shapes recorded 2026-10-14 from three read-only calls: `gh api graphql` for issue
// 999999 (NOT_FOUND), `gh api repos/<repo>/issues/999999/dependencies/blocked_by` (REST 404) and
// `gh issue view 999999 --repo jakebromberg/ship-dag --json state` (a missing issue), and from `execFileSync` of a
// binary that is not on PATH (spawn ENOENT). Which GraphQL bodies make gh exit 1 comes from gh 2.102.0's source.
// These are `realRunGh`'s shapes. `ghCli`'s promisified `execFile` throws the same message, stdout and stderr, but
// carries the exit code as `code` (no `status`) and says `spawn gh ENOENT` when there is no gh.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * An `execFileSync` failure: `status` (the exit code), `stdout`, `stderr`, and Node's `Command failed: gh <args>`
 * message, which adds `\n<stderr>` only when there is stderr. A `message` given replaces it, for a test of an
 * error whose text is not Node's; give it `stderr: null` too for ghFailure to read it, since ghFailure reads the
 * message only when `stderr` is null or absent.
 */
export function ghExecError(args, { stdout = '', stderr = '', status = 1, message } = {}) {
  const failed = `Command failed: gh ${args.join(' ')}`;
  return Object.assign(new Error(message ?? (stderr ? `${failed}\n${stderr}` : failed)), { status, stdout, stderr });
}

/** What `execFileSync` throws when there is no `gh` to run: a spawn ENOENT, with `status` null and no stdout or stderr. */
export function ghMissing(args) {
  return Object.assign(new Error('spawnSync gh ENOENT'), { code: 'ENOENT', errno: -2, syscall: 'spawnSync gh', path: 'gh', spawnargs: args, status: null });
}

/** A REST failure: the `{message, documentation_url, status}` body on stdout and `gh: <message> (HTTP NNN)` on stderr. */
export function restFailure(status, message, args = ['api', 'repos/o/r/issues/999999']) {
  const body = { message, documentation_url: 'https://docs.github.com/rest', status: String(status) };
  return ghExecError(args, { stdout: JSON.stringify(body), stderr: `gh: ${message} (HTTP ${status})\n` });
}

/** `gh issue view` of a missing issue: exit 1, nothing on stdout, and gh's GraphQL error on stderr. */
export function issueViewNotFound(number, args = ['issue', 'view', String(number)]) {
  return ghExecError(args, { stderr: `GraphQL: Could not resolve to an issue or pull request with the number of ${number}. (repository.issue)\n` });
}

/** The GraphQL body gh prints for a missing issue; the exit is 1, with this on stdout. */
export function notFoundBody(number) {
  const message = `Could not resolve to an Issue with the number of ${number}.`;
  return { data: { repository: { issue: null } }, errors: [{ type: 'NOT_FOUND', path: ['repository', 'issue'], locations: [{ line: 1, column: 1 }], message }] };
}

/**
 * The error text gh 2.102.0's `parseErrorResponse` (pkg/cmd/api/api.go) finds in a GraphQL body answered 200: a
 * string `errors` (with a top-level `message` in parentheses), else a top-level `message` with `(HTTP 200)`, else
 * each `errors` entry's message, one per line. A string entry is its own message, and an entry that is neither a
 * string nor an object is skipped. gh decodes every object entry into the same struct, so one with no `message`
 * repeats the message before it. gh exits 1 when this text is not empty.
 */
function serverError(body) {
  const { message, errors } = body ?? {};
  if (typeof errors === 'string' && errors) return message ? `${errors} (${message})` : errors;
  if (message) return `${message} (HTTP 200)`;
  if (!Array.isArray(errors)) return '';
  const said = [];
  let last = '';
  for (const e of errors) {
    if (typeof e === 'string') said.push(e);
    else if (e && typeof e === 'object' && !Array.isArray(e)) said.push((last = e.message ?? last));
  }
  return said.join('\n');
}

/** What `gh api graphql` throws for a body it exits 1 on: the body on stdout and `gh: <error text>` on stderr. */
export function graphqlFailure(body, args = ['api', 'graphql']) {
  const said = serverError(body);
  if (!said) throw new Error('gh exits 0 on this body: answer it with graphqlAnswer');
  return ghExecError(args, { stdout: JSON.stringify(body), stderr: `gh: ${said}\n` });
}

/** A GraphQL answer as `gh api graphql` gives it: graphqlFailure's exit 1 when gh finds error text, else the JSON. */
export function graphqlAnswer(body, args = ['api', 'graphql']) {
  if (!serverError(body)) return JSON.stringify(body);
  throw graphqlFailure(body, args);
}

/**
 * A stub `gh` for a CLI run as a subprocess: writes `<dir>/bin/gh`, which prints `stdout` and `stderr` and exits
 * `status` (a failure's are `ghExecError`'s fields, e.g. `restFailure(...)`), and returns `<dir>/bin` to put first
 * on PATH. Every call gets the same answer.
 */
export function ghStubBin(dir, { stdout = '', stderr = '', status = 0 } = {}) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh.stdout'), stdout);
  writeFileSync(join(bin, 'gh.stderr'), stderr);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\ncat '${join(bin, 'gh.stdout')}'\ncat '${join(bin, 'gh.stderr')}' >&2\nexit ${Number(status)}\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  return bin;
}
