// failure.mjs — routing an engine report row, and reading a dead session's
// terminal record, WITHOUT ingesting the transcript.
//
// Two lessons from run sd-20260831-162148 (daisysguide/backend#620) are baked
// in here:
//
//   1. `status: "failed"` does not mean "nothing shipped." That row carried
//      `prNumber: 625` with every GitHub check green — the session had already
//      committed, pushed, and opened the PR, and only then hit a quota stop.
//      SKILL.md's step-5 branches were written for `failed` rows with NO PR, so
//      this row matched nothing, the main agent improvised, and the improvised
//      path was `tail` on a 1.1MB session transcript. Worse, the engine's own
//      generated report recommends `--retry-failed`, which for this row would
//      have redone work that was already merged. `routeFailure` closes that
//      hole: a PR is the disambiguator, not the status.
//
//   2. The terminal `result` record reported `subtype: "success"` while
//      `is_error: true`. Anything that routes on subtype alone reads that
//      session as clean. `terminalEvent` therefore surfaces `isError`
//      separately rather than folding it into the subtype.
//
// The point of this module is that the caller never has to read the transcript
// into its own context: scripts/diagnose-failure.mjs does the file I/O and
// prints a few hundred bytes of JSON. See also `classifyFailureReason` in
// ./rate-limit.mjs, which answers "was this a rate-limit death?" from the same
// transcript and feeds `failureReason` here.

import { isRateLimitDeathLine } from './rate-limit.mjs';

/** JSON key present on every stream-json result record — a cheap prefilter that skips `JSON.parse` on the ~99% of transcript lines that cannot be one. */
const RESULT_TYPE_KEY = '"type":"result"';

/** Cap on the terminal `result` string. It is an assistant turn — unbounded in principle — and a diagnosis is read straight into an agent context. */
export const MAX_REASON_CHARS = 500;

/**
 * The filename stem the engine gives a ref's per-issue artifacts (logs,
 * metadata, failure digests). Mirrors claude-orchestrator's
 * `encodeRefForFilename` **exactly** — only `%`, `/` and `#` are escaped.
 *
 * Deliberately not `encodeURIComponent`: the two agree on every ref made of
 * legal GitHub owner/repo characters, which is precisely what would keep a
 * mismatch hidden until some ref contained a character they disagree about and
 * a lookup silently found no file.
 * @param {string} ref  composite issue ref, `owner/repo#N`
 */
export function artifactStem(ref) {
  return String(ref).replace(/%/g, '%25').replace(/\//g, '%2F').replace(/#/g, '%23');
}

/**
 * Parse one transcript line, returning the terminal-record fields when it is a
 * genuine session `result` event and `null` otherwise.
 *
 * Hook-emitted `result` records (tagged `hook_event_name`) return null: they
 * are a hook's output, not the session's, and a Stop hook's record can land
 * after the session's real terminal event.
 * @param {string} line
 * @returns {{subtype: string|null, isError: boolean, numTurns: number|null, reason: string|null}|null}
 */
export function parseTerminalResultLine(line) {
  if (!line || !line.trim() || !line.includes(RESULT_TYPE_KEY)) return null;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || obj.type !== 'result' || obj.hook_event_name) return null;
  return {
    subtype: obj.subtype ?? null,
    isError: obj.is_error === true,
    numTurns: typeof obj.num_turns === 'number' ? obj.num_turns : null,
    reason: typeof obj.result === 'string' ? obj.result : null,
  };
}

/**
 * A single-pass accumulator over transcript lines, collecting both facts a
 * diagnosis needs: the session's terminal record, and whether it died on a
 * rate limit.
 *
 * It exists so the two producers of a diagnosis traverse a transcript the same
 * way. The engine's post-run digest streams the file line-by-line (it may be
 * megabytes, and it is read while the run is still hot); `diagnose-failure.mjs`
 * folds over an already-read string. One definition, two drivers — which is
 * what stops them from drifting into disagreeing about the same transcript.
 */
export function createTranscriptScan() {
  let terminal = null;
  let rateLimited = false;
  return {
    /** @param {string} line */
    line(line) {
      const parsed = parseTerminalResultLine(line);
      if (parsed) terminal = parsed;
      if (!rateLimited && isRateLimitDeathLine(line)) rateLimited = true;
    },
    /** @returns {{terminal: object|null, rateLimited: boolean}} */
    result() {
      return { terminal, rateLimited };
    },
  };
}

/** Truncate to `MAX_REASON_CHARS`, marking the cut so a reader can tell the text was clipped rather than ending there. */
function clipReason(text) {
  if (typeof text !== 'string' || text.length <= MAX_REASON_CHARS) return text ?? null;
  return `${text.slice(0, MAX_REASON_CHARS)}…`;
}

/**
 * The canonical diagnosis object, from a report row plus whatever a transcript
 * scan found. Both producers emit exactly this shape, so a consumer never has
 * to care which one wrote it.
 *
 * `failureReason` prefers a structured `failureReason` on the row
 * (claude-orchestrator#87) over the transcript scan, and passes through ONLY
 * `"rate-limited"` — telemetry.mjs's enum is deliberately just that value or
 * null, so forwarding some future orchestrator reason would make the telemetry
 * append throw and drop the very failure record it exists to capture.
 *
 * @param {{row: object, terminal: object|null, rateLimited?: boolean, exitCode?: number|string|null}} opts
 */
export function buildDiagnosis({ row, terminal, rateLimited = false, exitCode = null }) {
  const structured = row?.failureReason === 'rate-limited';
  const failureReason = structured || rateLimited ? 'rate-limited' : null;
  return {
    ref: row?.ref ?? null,
    status: row?.status ?? null,
    prNumber: row?.prNumber ?? null,
    prUrl: row?.prUrl ?? null,
    exitCode,
    failureReason,
    route: routeFailure({ ...row, failureReason }),
    terminal: terminal ? { ...terminal, reason: clipReason(terminal.reason) } : null,
  };
}

/**
 * The session-terminating `result` record from a stream-json transcript,
 * reduced to the four fields worth reporting. Returns null when the session
 * died without writing one at all — itself diagnostic (a hard kill, not an
 * orderly stop).
 *
 * `isError` is deliberately separate from `subtype`: a real transcript pairs
 * `subtype: "success"` with `is_error: true` on a quota stop, so the subtype
 * is not a verdict.
 *
 * Hook-emitted `result` records (tagged `hook_event_name`) are skipped: they
 * are a hook's output, not the session's.
 *
 * Never throws — an unparseable or blank line is skipped, not fatal, so a
 * truncated transcript (the common shape when a session is killed mid-write)
 * still yields whatever came before it.
 * @param {string|null|undefined} transcriptText
 * @returns {{subtype: string|null, isError: boolean, numTurns: number|null, reason: string|null}|null}
 */
export function terminalEvent(transcriptText) {
  if (!transcriptText) return null;
  const scan = createTranscriptScan();
  for (const line of transcriptText.split('\n')) scan.line(line);
  return scan.result().terminal;
}

/**
 * Where a report row belongs in SKILL.md step 5, decided by whether a PR
 * exists rather than by `status`:
 *
 * - `review-gate` — a PR is open (whatever the row's status). The implement
 *   work landed; gate it exactly like a `succeeded` row. Never retry it: the
 *   branch already exists and the work may already be merged.
 * - `find-pr` — a `succeeded` row with no PR. The session finished but the
 *   engine never captured its PR (it recognises one only by the branch it
 *   checked out). Look the PR up by issue before gating anything.
 * - `point-E` — no PR, and the session died on quota. Infra failure, not a
 *   model failure: resume in place per the point-E recovery recipe. Re-running
 *   the engine for this issue would collide with its existing branch.
 * - `point-B` — no PR, ordinary implement stall. Grill the human.
 *
 * @param {{status?: string, prNumber?: number|null, failureReason?: string|null}} row
 * @returns {"review-gate"|"find-pr"|"point-E"|"point-B"}
 */
export function routeFailure(row) {
  const { status, prNumber, failureReason } = row ?? {};
  // A PR number is the disambiguator. `> 0` rather than a truthiness check so a
  // 0 can't read as "a PR exists" — routing a PR-less stall to a gate with
  // nothing to review is the expensive direction to be wrong in.
  if (typeof prNumber === 'number' && prNumber > 0) return 'review-gate';
  if (status === 'succeeded') return 'find-pr';
  if (failureReason === 'rate-limited') return 'point-E';
  return 'point-B';
}
