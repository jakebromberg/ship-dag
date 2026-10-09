// wave-records.mjs — derive a wave's telemetry issue records from the engine's own
// artifacts, so emission is a consequence of the wave rather than a reminder.
//
// The caller reads the artifacts and hands in what they hold: the report, the
// wave's sidecar entry (`findWaveContext`), the failure digests, and each ref's
// review rounds as `reviewRoundFiles` lists them (oldest first by mtime), each
// file parsed. Only `--outcomes` supplies what no artifact records: `hitl.pointB`,
// a manual `finalState`, a PR the report row lacks, and a floor for `bounces`.
//
// Beyond its arguments it touches two things: `isUnreadableEmpty` checks each
// round's path for a `.raw` sibling (one rule for the #2587 signature, kept in
// review-rounds.mjs), and `references/tuning.json` is loaded once, only when
// neither the entry nor `opts.tuningVersion` gives a tuning version.
//
// A row is recorded once it is terminal for this wave: `pending`, `running` and
// `interrupted` rows are left for the ingest that sees them finish.
import { DEFAULT_BLOCK_ON, gateReview } from '../review-gate.mjs';
import { routeFailure } from './failure.mjs';
import { isUnreadableEmpty } from './review-rounds.mjs';
import { runIdFromConfigName, sameRun } from './run-id.mjs';
import { load as loadTuning } from './tuning.mjs';

const SEVERITY = { clean: 0, 'nits-only': 1, blocking: 2 };
const NOT_TERMINAL = new Set(['pending', 'running', 'interrupted']);

/** One round's verdict: unparseable, or empty beside its `.raw` (`isUnreadableEmpty`), is `blocking`. */
function roundVerdict({ path, review }, blockOn) {
  if (isUnreadableEmpty(path, review)) return 'blocking';
  try { return gateReview(review, blockOn).verdict; } catch { return 'blocking'; }
}

/** Whether `a` and `b` are the same event: `sameRun`, ref, finalState, and failureReason (absent reads as null). */
const sameRecord = (a, b) => sameRun(a.runId, b.runId) && a.repo === b.repo && a.issue === b.issue
  && a.finalState === b.finalState && (a.failureReason ?? null) === (b.failureReason ?? null);

/**
 * Derive one telemetry issue record per row of the wave `report` that is terminal for this wave.
 * @param {object} report parsed `<stateDir>/state/reports/<id>.json`
 * @param {object|null} entry this wave's sidecar entry (`findWaveContext`), or null
 * @param {Record<string, object>} digests failure digests by ref; read only for rows that did not succeed
 * @param {Record<string, Array<{path: string, review: object|null}>>} rounds each ref's rounds, oldest first
 *   as `reviewRoundFiles` returns them; `review` is the parsed file, null when unparseable
 * @param {Record<string, object>} outcomes per-ref `{pr, hitl, finalState, bounces, findings, tokens}`
 * @param {{existing?: object[], warn?: (m: string) => void, tuningVersion?: unknown}} [opts]
 *   a record matching an `existing` one (or an earlier row's) on `sameRun`, ref, finalState and failureReason is dropped
 * @returns {{records: object[]}}
 * @throws when no run id can be determined (no `entry.runId`, no `report.configName`), or a
 *   `succeeded` row has no PR in the report or the outcomes
 */
export function deriveWaveRecords(report, entry, digests, rounds, outcomes, { existing = [], warn = (m) => console.error(m), tuningVersion } = {}) {
  const rows = (Array.isArray(report?.issues) ? report.issues : []).filter((r) => !NOT_TERMINAL.has(r.status));
  const runId = entry?.runId || runIdFromConfigName(report?.configName);
  if (!runId) throw new Error('no run id: the wave has no sidecar entry with a runId and the report has no configName');
  const blockOn = entry?.blockOn ?? DEFAULT_BLOCK_ON;
  const version = entry?.tuningVersion ?? tuningVersion ?? loadTuning().version;

  const halfSupplied = rows.filter((r) => r.status === 'succeeded' && !r.prNumber && !outcomes?.[r.ref]?.pr).map((r) => r.ref);
  if (halfSupplied.length) throw new Error(`half-supplied wave: succeeded with no PR in the report or --outcomes: ${halfSupplied.join(', ')}`);

  const seen = [...existing];
  const records = [];
  for (const row of rows) {
    const m = /^(.+)#(\d+)$/.exec(row.ref ?? '');
    if (!m) throw new Error(`half-supplied wave: row without an owner/repo#N ref: ${JSON.stringify(row)}`);
    const outcome = outcomes?.[row.ref] ?? {};
    const planned = (entry?.issues ?? []).find((i) => i.ref === row.ref);
    const pr = row.prNumber ?? outcome.pr ?? null;
    // Digests are written for non-succeeded rows and never removed, so a succeeded
    // row's digest is a stale one from an earlier wave.
    const digest = row.status === 'succeeded' ? null : digests?.[row.ref];
    const failureReason = (digest?.failureReason ?? row.failureReason) === 'rate-limited' ? 'rate-limited' : null;
    const skipped = row.status === 'skipped';
    const reviewed = routeFailure({ ...row, prNumber: pr, failureReason }) === 'review-gate';

    const refRounds = rounds?.[row.ref] ?? [];
    const verdicts = refRounds.map((r) => roundVerdict(r, blockOn));
    // A round is a bounce when the round before it blocked; a re-gate after a clean
    // round (a rebase moving the base) is not.
    const bounced = verdicts.map((_, i) => i > 0 && verdicts[i - 1] === 'blocking');
    refRounds.forEach((r, i) => {
      const trigger = r.review?.meta?.trigger;
      if (trigger && i > 0 && (trigger === 'review-loop') !== bounced[i]) warn(`${row.ref}: ${r.path} says trigger "${trigger}" but its predecessor ${verdicts[i - 1]}`);
    });

    const rec = {
      runId,
      repo: m[1],
      issue: Number(m[2]),
      complexity: planned?.complexity ?? 'normal',
      triageStatus: 'clear',
      assignment: planned?.model ?? null,
      effort: planned?.effort ?? null,
      effortSource: planned?.effortSource ?? null,
      model: planned?.model ?? null,
      path: 'engine',
      // `skipped` never reached implement. `blocked` is not an engine status, but
      // SKILL.md step 5 and the failure-routing tests hand it in as one, so it stays.
      implStatus: skipped ? null : reviewed ? 'pushed' : row.status === 'blocked' ? 'blocked' : 'error',
      ciStatus: row.status === 'succeeded' ? 'pass' : null,
      reviewVerdict: verdicts.length ? verdicts.reduce((w, v) => (SEVERITY[v] > SEVERITY[w] ? v : w)) : null,
      reviewPath: refRounds.at(-1)?.path ?? null,
      failureReason,
      findings: outcome.findings ?? [],
      bounces: Math.max(outcome.bounces ?? 0, bounced.filter(Boolean).length),
      hitl: { pointA: false, pointB: !!outcome.hitl?.pointB },
      finalState: outcome.finalState ?? (skipped ? 'deferred' : pr ? 'merged' : 'error'),
      pr,
      tokens: outcome.tokens ?? null,
      policySource: entry?.blockOn ? 'sidecar' : 'default',
      tuningVersion: version,
      ts: report.finishedAt || report.startedAt,
    };
    if (seen.some((s) => sameRecord(s, rec))) continue;
    seen.push(rec);
    records.push(rec);
  }
  return { records };
}
