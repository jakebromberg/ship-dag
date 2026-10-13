// resource.mjs — the pure half of resource-preflight.mjs: claude-orchestrator's
// threshold table, read through its ship-dag column.
//
//   level      ship-dag preflight
//   normal     proceed, K
//   warning    proceed, K (the engine adapts live)
//   critical   wait up to the cap, then hitl (HITL point F) — never a start
//   unknown    proceed (no pressure signal on this platform)
//
// Waiting does not relieve memory pressure, so no wait cap ever turns into a
// start: the cap ends in asking.

/** How many minutes SKILL.md's loop waits at `critical` before asking. */
export const DEFAULT_WAIT_MAX_MINUTES = 15;

/** The parallelism the engine is asked for when the caller names none. */
export const DEFAULT_PARALLEL = 4;

/**
 * The decision for one sampled pressure level. An unrecognised level reads as
 * `critical`: a failed read must never open capacity.
 * @param {{level: string, parallel?: number, waitedMinutes?: number, waitMaxMinutes?: number}} opts
 * @returns {{action: 'proceed'|'wait'|'hitl', reason: string, recommendedParallel: number}}
 */
export function resourceDecision({ level, parallel = DEFAULT_PARALLEL, waitedMinutes = 0, waitMaxMinutes = DEFAULT_WAIT_MAX_MINUTES }) {
  if (level === 'normal') return { action: 'proceed', reason: 'normal', recommendedParallel: parallel };
  if (level === 'warning') return { action: 'proceed', reason: 'warning-engine-adapts', recommendedParallel: parallel };
  if (level === 'unknown') return { action: 'proceed', reason: 'no-signal', recommendedParallel: parallel };
  if (waitedMinutes < waitMaxMinutes) return { action: 'wait', reason: 'critical-wait', recommendedParallel: 0 };
  return { action: 'hitl', reason: 'critical-hitl', recommendedParallel: 0 };
}
