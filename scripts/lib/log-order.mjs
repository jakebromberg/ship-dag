// log-order.mjs — the one ordering of telemetry records by `ts`, and the one latest-record-per-ref fold built on it.
import { formatRef, refKey } from './ref.mjs';

const tsOf = (r) => { const t = Date.parse(r.ts); return Number.isNaN(t) ? -Infinity : t; };

/** Compare records oldest first by `ts`. Transitive: a record with no parseable `ts` sorts first, and equal times compare 0, so a stable sort keeps log order. Newest first is `(a, b) => byTs(b, a)`. */
export const byTs = (a, b) => (tsOf(a) === tsOf(b) ? 0 : tsOf(a) < tsOf(b) ? -1 : 1);

/** A `Map` from `refKey(formatRef(repo, issue))` to that issue's latest record by `ts` (a later ingest can append an earlier event). Retro records have no issue and are left out. */
export const latestByRef = (records) => new Map(records.filter((r) => r.kind !== 'retro').sort(byTs).map((r) => [refKey(formatRef(r.repo, r.issue)), r]));
