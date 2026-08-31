// rate-limit.mjs — pure helpers for the five-hour rate-limit window: parsing
// `rate_limit_event` records out of an engine session transcript (the
// `--output-format stream-json` log the engine already writes to
// `<configDir>/logs/issue-<url-encoded-ref>.log`), and the preflight/HITL-fork decision
// SKILL.md step 4 makes from the newest one it can find.
//
// No I/O, no globals, no clock beyond an injected `now` — safe to import
// anywhere and unit-test under `node --test`, matching scripts/lib/stats.mjs.

// A cheap prefilter for the synthetic-turn check in isRateLimitDeath, below.
// Deliberately the JSON *key* the record carries the structured signal under,
// not the English prose the CLI happens to word the message with today — a
// copy change to the prose can't silently disable the structured check the
// way substring-matching on the prose itself would.
const IS_API_ERROR_MESSAGE_KEY = '"is_api_error_message"';

/** Epoch seconds (the transcript's unit for every `resetsAt`) → ISO string. */
function epochSecondsToIso(seconds) {
  return typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null;
}

/**
 * Parse every `rate_limit_event` line out of a stream-json transcript. Lines
 * that fail to parse (torn writes, non-JSON noise) are skipped rather than
 * throwing, and only top-level `type: "rate_limit_event"` records are
 * considered — a coincidental lookalike field on an unrelated event type
 * (e.g. echoed in a tool result) is not mistaken for the real one.
 *
 * The real record nests everything under `rate_limit_info`, whose shape
 * varies by which window it's reporting on: a plain `{status, resetsAt,
 * rateLimitType, utilization?}` for that one window, PLUS an optional
 * `unifiedWindows: {five_hour, seven_day}` breakdown (each `{utilization,
 * resetsAt}`) once the CLI has both windows' current state to report. Five-
 * hour utilization/resetsAt are read preferentially from `unifiedWindows`
 * (authoritative regardless of which window the event itself is about);
 * falling back to the flat fields only when `rateLimitType` is itself
 * `"five_hour"` (an early/warning event with no unified breakdown yet).
 * `resetsAt` on the wire is epoch seconds; this returns ISO strings.
 * @param {string} text
 * @returns {Array<{status: string|null, utilization: number|null, resetsAt: string|null, raw: object}>}
 */
export function parseRateLimitEvents(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || obj.type !== 'rate_limit_event') continue;
    const info = obj.rate_limit_info ?? {};
    const fiveHour = info.unifiedWindows?.five_hour;
    let utilization = null;
    let resetsAt = null;
    if (fiveHour) {
      utilization = fiveHour.utilization ?? null;
      resetsAt = epochSecondsToIso(fiveHour.resetsAt);
    } else if (info.rateLimitType === 'five_hour') {
      utilization = info.utilization ?? null;
      resetsAt = epochSecondsToIso(info.resetsAt);
    }
    out.push({
      status: info.status ?? null,
      utilization,
      resetsAt,
      raw: obj,
    });
  }
  return out;
}

/**
 * The newest `rate_limit_event` carrying five-hour utilization (transcripts
 * are append-only, so "last matching line" is "newest"). Early-session events
 * can predate the CLI's `unifiedWindows` breakdown and carry no five-hour
 * data at all (see parseRateLimitEvents); those are skipped in favor of the
 * latest one that does, rather than blindly returning the last line. Null if
 * the transcript has no rate_limit_event with five-hour data.
 * @param {string} text
 */
export function latestRateLimitEvent(text) {
  const events = parseRateLimitEvents(text).filter((e) => e.utilization != null);
  return events.length ? events[events.length - 1] : null;
}

/**
 * Whether a session transcript shows the rate-limit-death signature. Two
 * independent anchors, either sufficient on its own:
 *   1. The CLI's synthetic assistant turn when the window rejects a request —
 *      `{type: "assistant", error: "rate_limit", is_api_error_message: true,
 *      message: {content: [{type: "text", text: "You've hit your session
 *      limit · resets ..."}]}}`. This is the actual death signal; anchoring
 *      on the structured `error`/`is_api_error_message` fields (not a
 *      whole-transcript substring search on the prose) avoids two failure
 *      modes at once: false-positiving on a session whose prompt merely
 *      *discusses* rate limits (e.g. this very feature's own issue body), and
 *      false-negativing when the CLI rewords the message text — a prose
 *      substring check alone would silently stop matching. The structured
 *      fields are tested first; `IS_API_ERROR_MESSAGE_KEY` is used only as a
 *      cheap prefilter to skip `JSON.parse` on lines that plainly can't carry
 *      the field, and matches the JSON *key* rather than any prose so it
 *      can't mask the structured check the way a prose-substring prefilter
 *      did before.
 *   2. A `rate_limit_event` whose `status` is `"rejected"`.
 * @param {string} text
 */
export function isRateLimitDeath(text) {
  for (const line of text.split('\n')) {
    if (!line.trim() || !line.includes(IS_API_ERROR_MESSAGE_KEY)) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj && obj.type === 'assistant' && obj.error === 'rate_limit' && obj.is_api_error_message === true) {
      return true;
    }
  }
  return parseRateLimitEvents(text).some((e) => e.status === 'rejected');
}

/**
 * Classify a failed engine report row's failure reason. Prefers the
 * structured `failureReason` field on the row when present (claude-orchestrator#87,
 * not yet shipped as of this writing); falls back to parsing the failed
 * session's transcript for the rate-limit-death signature. Returns null when
 * neither source identifies a rate-limit death (an ordinary implement failure).
 *
 * Only ever returns `"rate-limited"` or `null` — telemetry.mjs's `failureReason`
 * enum is deliberately kept to just those two (see the issue's decision
 * comment), so a report row carrying some other future value (a claude-orchestrator#87
 * reason this schema doesn't know about yet) is treated as unclassified here
 * rather than passed through, which would otherwise make the telemetry append
 * throw and silently drop the very failure record this exists to capture.
 * @param {{failureReason?: string}|null|undefined} reportRow
 * @param {string|null|undefined} transcriptText
 * @returns {"rate-limited"|null}
 */
export function classifyFailureReason(reportRow, transcriptText) {
  if (reportRow && reportRow.failureReason === 'rate-limited') return 'rate-limited';
  if (transcriptText && isRateLimitDeath(transcriptText)) return 'rate-limited';
  return null;
}

/**
 * The step-4 preflight fork: given the newest known five-hour utilization
 * (possibly absent), decide whether to proceed, wait for the window to
 * reset, or surface a HITL fork.
 *
 * - No utilization data → `proceed` (fail-open: a fresh machine with no
 *   recent session logs must not be blocked by absent telemetry).
 * - Below `threshold` → `proceed`.
 * - At/above `threshold` but `resetsAt` is already in the past → `proceed`
 *   (this utilization reading no longer describes the current window — the
 *   newest log the preflight found is stale, e.g. left over from a run whose
 *   window has since reset with no new session yet to report the fresh one).
 * - At/above `threshold` and the window resets within `waitMaxMinutes` →
 *   `wait` (the caller prints resetsAt and waits).
 * - At/above `threshold` and the reset is further off (or unknown) →
 *   `hitl` (wait / defer the wave / stop the run).
 * @param {{utilization: number|null, resetsAt: string|null, now?: Date, threshold?: number, waitMaxMinutes?: number}} opts
 */
export function preflightDecision({ utilization, resetsAt, now = new Date(), threshold = 0.8, waitMaxMinutes = 30 }) {
  if (utilization == null) {
    return { action: 'proceed', reason: 'no-utilization-data', utilization: null };
  }
  if (utilization < threshold) {
    return { action: 'proceed', reason: 'below-threshold', utilization };
  }
  if (!resetsAt) {
    return { action: 'hitl', reason: 'above-threshold-no-reset-time', utilization, resetsAt: null };
  }
  const minutesUntilReset = (new Date(resetsAt).getTime() - now.getTime()) / 60000;
  if (minutesUntilReset <= 0) {
    return { action: 'proceed', reason: 'window-already-reset', utilization, resetsAt, minutesUntilReset };
  }
  if (minutesUntilReset <= waitMaxMinutes) {
    return { action: 'wait', reason: 'reset-soon', utilization, resetsAt, minutesUntilReset };
  }
  return { action: 'hitl', reason: 'reset-far', utilization, resetsAt, minutesUntilReset };
}
