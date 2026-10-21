// gh.mjs — the `gh` CLI seam: run it, classify a failure, retry a rate limit, parse its JSON. `gh` is injected
// everywhere, as `async (args) => stdout` or, where the caller is sync, as `(args) => stdout`, so nothing here
// touches GitHub unless a caller passes one of the two real runners, `ghCli` or `realRunGh`.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

/** The default `gh`: run the CLI and return stdout. */
export const ghCli = async (args) => (await promisify(execFile)('gh', args, { maxBuffer: 64 << 20 })).stdout;

/** The sync counterpart of `ghCli`: run `gh` for real and return its stdout. `opts` are `execFileSync` options, such as a `timeout`. */
export function realRunGh(args, opts = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', ...opts });
}

/**
 * A failed `gh` call's stdout body, parsed: the JSON `gh api` prints on an HTTP error (`{message, status}`) or
 * a GraphQL response with `errors`. Null when stdout is absent or not JSON. The only place that body is parsed.
 */
export function ghErrorBody(err) {
  try { return JSON.parse(err?.stdout); } catch { return null; }
}

/** Whether a failed `gh` call's GraphQL body holds errors and every one is NOT_FOUND. That is all it checks; it does not prove the issue is absent, so callers pair it with their own absence check. */
export function ghNotFound(err) {
  const errors = ghErrorBody(err)?.errors;
  return Array.isArray(errors) && errors.length > 0 && errors.every((e) => e?.type === 'NOT_FOUND');
}

/**
 * What a failed `gh` call means, `{status, rateLimited}`. `status` is the HTTP status: `err.stdout`'s JSON
 * `status` (what `gh api` prints on an HTTP error), else the `(HTTP NNN)` or `HTTP NNN:` gh writes to stderr
 * (or, with no stderr, to the message), else null (a network error, or no gh). `rateLimited` is a 429, a 403
 * whose body or message says "rate limit", or, with no status (`gh search`), that text alone. This is the
 * only place gh's error text is matched.
 */
export function ghFailure(err) {
  const body = ghErrorBody(err);
  const text = String(err?.stderr ?? err?.message ?? '');
  const status = Number(body?.status ?? /\(HTTP (\d{3})\)|HTTP (\d{3}):/.exec(text)?.slice(1).find(Boolean)) || null;
  const said = /rate limit/i.test(`${body?.message ?? ''} ${text}`);
  return { status, rateLimited: status === 429 || (said && (status === 403 || status === null)) };
}

/**
 * Run `fn`, retrying a GitHub rate-limit error with doubling waits (2s, 4s, ... 32s: about the minute
 * GitHub's search limit spans). After `retries` retries it throws, naming `repo`; any other error is
 * thrown as is.
 */
export async function withBackoff(fn, { repo, retries = 5, baseMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await fn(); } catch (err) {
      if (!ghFailure(err).rateLimited) throw err;
      if (attempt >= retries) throw new Error(`${repo}: GitHub rate limit persisted after ${retries} retries: ${err.message}`);
      await sleep(baseMs * 2 ** attempt);
    }
  }
}

/**
 * `gh args`, parsed, with backoff: `{value}`, or `{failure}` (`ghFailure`'s) after a warning `prefix: what:
 * error` when it fails other than on a rate limit, which throws.
 */
export async function ghJson(args, what, { gh, repo, sleep, warn, prefix }) {
  try { return { value: JSON.parse(await withBackoff(() => gh(args), { repo, sleep })) }; } catch (err) {
    const failure = ghFailure(err);
    if (failure.rateLimited) throw err;
    warn(`${prefix}: ${what}: ${err.message}`);
    return { failure };
  }
}
