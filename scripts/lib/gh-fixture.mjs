// gh-fixture.mjs — test support (not a test file): what a failed `gh` call throws through `realRunGh`
// (`execFileSync('gh', args, { encoding: 'utf8' })`), so fakes share one shape and `ghFailure` and `ghErrorBody`
// read them as they read real gh. Shapes recorded 2026-10-14 from two read-only calls: `gh api graphql` for issue
// 999999 (NOT_FOUND) and `gh api repos/<repo>/issues/999999/dependencies/blocked_by` (REST 404).

/** An `execFileSync` failure: `status` (the exit code), `stdout`, `stderr`, and gh's `Command failed` message (or `message`). */
export function ghExecError(args, { stdout = '', stderr = '', status = 1, message } = {}) {
  return Object.assign(new Error(message ?? `Command failed: gh ${args.join(' ')}\n${stderr ?? ''}`), { status, stdout, stderr });
}

/** A REST failure: the `{message, documentation_url, status}` body on stdout and `gh: <message> (HTTP NNN)` on stderr. */
export function restFailure(status, message, args = ['api', 'repos/o/r/issues/999999']) {
  const body = { message, documentation_url: 'https://docs.github.com/rest', status: String(status) };
  return ghExecError(args, { stdout: JSON.stringify(body), stderr: `gh: ${message} (HTTP ${status})\n` });
}

/** The GraphQL body gh prints for a missing issue; the exit is 1, with this on stdout. */
export function notFoundBody(number) {
  const message = `Could not resolve to an Issue with the number of ${number}.`;
  return { data: { repository: { issue: null } }, errors: [{ type: 'NOT_FOUND', path: ['repository', 'issue'], locations: [{ line: 1, column: 1 }], message }] };
}

/** A GraphQL answer as `gh api graphql` gives it: the JSON text, or, when the body has `errors`, gh's exit 1. */
export function graphqlAnswer(body, args = ['api', 'graphql']) {
  if (!body?.errors) return JSON.stringify(body);
  throw ghExecError(args, { stdout: JSON.stringify(body), stderr: `gh: ${body.errors[0]?.message}\n` });
}
