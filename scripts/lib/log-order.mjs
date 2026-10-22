// log-order.mjs — the one ordering of telemetry records by `ts`, and the one latest-record-per-ref fold built on it.
import { issueKey } from './ref.mjs';
import { ENGINE_DIED, INFRA_REASONS, SKIP_REASON_DEPENDENCY } from './failure.mjs';

const tsOf = (r) => { const t = Date.parse(r.ts); return Number.isNaN(t) ? -Infinity : t; };

/** Compare records oldest first by `ts`. Transitive: a record with no parseable `ts` sorts first, and equal times compare 0, so a stable sort keeps log order. Newest first is `(a, b) => byTs(b, a)`. */
export const byTs = (a, b) => (tsOf(a) === tsOf(b) ? 0 : tsOf(a) < tsOf(b) ? -1 : 1);

/** A `Map` from `issueKey` to that issue's latest record by `ts` (a later ingest can append an earlier event). Retro records have no issue and are left out. */
export const latestByRef = (records) => new Map(records.filter((r) => r.kind !== 'retro').sort(byTs).map((r) => [issueKey(r), r]));

/**
 * What a ref's latest record means, as one of `merged`, `skipped` (an engine skip of a dependent, `skipReason: SKIP_REASON_DEPENDENCY`, even when `--outcomes` marked it blocked-hitl),
 * `engine-died` (a deferral with `failureReason: "engine-died"` and `implStatus: "error"`; a point-F hold keeps the reason but not the status),
 * `infra-stopped` (any other `INFRA_REASONS` stop), `maintainer-deferred` (an unmarked deferral) or `failed`. Only `merged` and `maintainer-deferred` are resolved.
 */
export const outcomeOf = (r) => {
  if (r.finalState === 'merged') return 'merged';
  if (r.skipReason === SKIP_REASON_DEPENDENCY) return 'skipped';
  if (r.failureReason === ENGINE_DIED && r.implStatus === 'error' && r.finalState === 'deferred') return ENGINE_DIED;
  if (INFRA_REASONS.has(r.failureReason)) return 'infra-stopped';
  return r.finalState === 'deferred' && !r.skipReason ? 'maintainer-deferred' : 'failed';
};
