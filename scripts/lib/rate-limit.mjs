// rate-limit.mjs — pure helpers for the five-hour rate-limit window: parsing
// `rate_limit_event` records out of an engine session transcript (the
// `--output-format stream-json` log the engine already writes to
// `<configDir>/logs/issue-<ref>.log`), and the preflight/HITL-fork decision
// SKILL.md step 4 makes from the newest one it can find.
//
// No I/O, no globals, no clock beyond an injected `now` — safe to import
// anywhere and unit-test under `node --test`, matching scripts/lib/stats.mjs.

const DEATH_MARKER = "hit your session limit";

/**
 * Parse every `rate_limit_event` line out of a stream-json transcript. Lines
 * that fail to parse (torn writes, non-JSON noise) are skipped rather than
 * throwing, and only top-level `type: "rate_limit_event"` records are
 * considered — a coincidental `unifiedWindows`-shaped field on an unrelated
 * event type (e.g. echoed in a tool result) is not mistaken for the real one.
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
    const fiveHour = obj.unifiedWindows?.five_hour;
    out.push({
      status: obj.status ?? null,
      utilization: fiveHour?.utilization ?? null,
      resetsAt: fiveHour?.resetsAt ?? null,
      raw: obj,
    });
  }
  return out;
}

/**
 * The newest `rate_limit_event` in a transcript (transcripts are append-only,
 * so "last line" is "newest"), or null if the transcript has none.
 * @param {string} text
 */
export function latestRateLimitEvent(text) {
  const events = parseRateLimitEvents(text);
  return events.length ? events[events.length - 1] : null;
}

/**
 * Whether a session transcript shows the rate-limit-death signature: a
 * `rate_limit_event` the window rejected, or the CLI's synthetic final result
 * ("You've hit your session limit ..."). Either is sufficient on its own —
 * the synthetic result can appear without a captured event line if the
 * transcript was truncated mid-write.
 * @param {string} text
 */
export function isRateLimitDeath(text) {
  if (text.includes(DEATH_MARKER)) return true;
  return parseRateLimitEvents(text).some((e) => e.status === 'rejected');
}

/**
 * Classify a failed engine report row's failure reason. Prefers the
 * structured `failureReason` field on the row when present (claude-orchestrator#87,
 * not yet shipped as of this writing); falls back to parsing the failed
 * session's transcript for the rate-limit-death signature. Returns null when
 * neither source identifies a rate-limit death (an ordinary implement failure).
 * @param {{failureReason?: string}|null|undefined} reportRow
 * @param {string|null|undefined} transcriptText
 * @returns {string|null}
 */
export function classifyFailureReason(reportRow, transcriptText) {
  if (reportRow && typeof reportRow.failureReason === 'string') return reportRow.failureReason;
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
  if (minutesUntilReset <= waitMaxMinutes) {
    return { action: 'wait', reason: 'reset-soon', utilization, resetsAt, minutesUntilReset };
  }
  return { action: 'hitl', reason: 'reset-far', utilization, resetsAt, minutesUntilReset };
}
