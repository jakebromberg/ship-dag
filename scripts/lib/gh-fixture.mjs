// gh-fixture.mjs — test support (not a test file): what a failed `gh` call throws through `realRunGh`
// (`execFileSync('gh', args, { encoding: 'utf8' })`), so fakes share one shape and `ghFailure` and `ghErrorBody`
// read them as they read real gh. Shapes recorded 2026-10-14 from three read-only calls: `gh api graphql` for issue
// 999999 (NOT_FOUND), `gh api repos/<repo>/issues/999999/dependencies/blocked_by` (REST 404) and
// `gh issue view 999999 --repo jakebromberg/ship-dag --json state` (a missing issue), and from `execFileSync` of a
// binary that is not on PATH (spawn ENOENT). Which GraphQL bodies make gh exit 1 comes from gh 2.102.0's source.

/**
 * An `execFileSync` failure: `status` (the exit code), `stdout`, `stderr`, and Node's `Command failed: gh <args>`
 * message, which adds `\n<stderr>` only when there is stderr. A `message` given replaces it, for a test of an
 * error whose text is not Node's (ghFailure reads the message only when there is no stderr).
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
 * A GraphQL answer as `gh api graphql` gives it, per `parseErrorResponse` in gh 2.102.0's pkg/cmd/api/api.go: gh
 * joins the `errors`' messages, one per line (an error with no `message` repeats the one before it, because gh
 * decodes each into the same struct), and exits 1 with the body on stdout and `gh: <messages>` on stderr when that
 * text is not empty. Otherwise (no `errors`, an empty list, or no message at all) it prints the JSON and exits 0.
 */
export function graphqlAnswer(body, args = ['api', 'graphql']) {
  let last = '';
  const said = (body?.errors ?? []).map((e) => (last = e?.message ?? last)).join('\n');
  if (!said) return JSON.stringify(body);
  throw ghExecError(args, { stdout: JSON.stringify(body), stderr: `gh: ${said}\n` });
}
