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

/** JSON key present on every stream-json result record — a cheap prefilter that skips `JSON.parse` on the ~99% of transcript lines that cannot be one. */
const RESULT_TYPE_KEY = '"type":"result"';

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
  let found = null;
  for (const line of transcriptText.split('\n')) {
    if (!line.trim() || !line.includes(RESULT_TYPE_KEY)) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    // Hooks emit their own `result`-typed records, tagged with hook_event_name.
    // A Stop hook's record can land after the session's real terminal event, so
    // taking the last result unconditionally would report the hook's output as
    // the reason the session died.
    if (!obj || obj.type !== 'result' || obj.hook_event_name) continue;
    found = {
      subtype: obj.subtype ?? null,
      isError: obj.is_error === true,
      numTurns: typeof obj.num_turns === 'number' ? obj.num_turns : null,
      reason: typeof obj.result === 'string' ? obj.result : null,
    };
  }
  return found;
}

/**
 * Where a report row belongs in SKILL.md step 5, decided by whether a PR
 * exists rather than by `status`:
 *
 * - `review-gate` — a PR is open (whatever the row's status). The implement
 *   work landed; gate it exactly like a `succeeded` row. Never retry it: the
 *   branch already exists and the work may already be merged.
 * - `point-E` — no PR, and the session died on quota. Infra failure, not a
 *   model failure: resume in place per the point-E recovery recipe. Re-running
 *   the engine for this issue would collide with its existing branch.
 * - `point-B` — no PR, ordinary implement stall. Grill the human.
 *
 * @param {{status?: string, prNumber?: number|null, failureReason?: string|null}} row
 * @returns {"review-gate"|"point-E"|"point-B"}
 */
export function routeFailure(row) {
  const { status, prNumber, failureReason } = row ?? {};
  // A PR number is the disambiguator. `> 0` rather than a truthiness check so a
  // 0 can't read as "a PR exists" — routing a PR-less stall to a gate with
  // nothing to review is the expensive direction to be wrong in.
  if (typeof prNumber === 'number' && prNumber > 0) return 'review-gate';
  if (status === 'succeeded') return 'review-gate';
  if (failureReason === 'rate-limited') return 'point-E';
  return 'point-B';
}
