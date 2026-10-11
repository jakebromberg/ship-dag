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
// A row is recorded once it is terminal for this wave (`succeeded`, `failed`,
// `blocked`, `skipped`): `pending`, `running` and `interrupted` rows are left for
// the ingest that sees them finish, and any other status is warned about and skipped.
import { DEFAULT_BLOCK_ON, gateReview } from '../review-gate.mjs';
import { routeFailure } from './failure.mjs';
import { isUnreadableEmpty } from './review-rounds.mjs';
import { runIdFromConfigName, sameRun } from './run-id.mjs';
import { load as loadTuning } from './tuning.mjs';

/**
 * A refusal to derive records from the artifacts handed in, as distinct from a bug. `kind` is the
 * contract callers dispatch on (`half-supplied`, `no-run-id`, `malformed-row`); the message is for
 * people and may be reworded. A `half-supplied` refusal also carries `noPr` and `lastBlocks`.
 */
export class WaveRefusal extends Error {
  constructor(kind, message, extra) { super(message); this.kind = kind; Object.assign(this, extra); }
}

const SEVERITY = { clean: 0, 'nits-only': 1, blocking: 2 };
const TERMINAL = new Set(['succeeded', 'failed', 'blocked', 'skipped']);
const NOT_YET = new Set(['pending', 'running', 'interrupted']);
// What routeFailure counts as a PR, so the half-supplied check and the record agree with it.
const isPr = (n) => typeof n === 'number' && n > 0;
// A succeeded row is supplied by a PR, in the report or --outcomes, or by an outcome
// saying it never merged: point B left a find-pr row without one.
const NOT_MERGED = new Set(['blocked-hitl', 'deferred', 'error']);
/** An `owner/repo#N` ref, capturing `owner/repo` and `N`: the one pattern ingest-wave checks a report against too. */
export const REF_RE = /^([^/#]+\/[^#]+)#(\d+)$/;
const supplied = (row, outcome) => isPr(row.prNumber) || isPr(outcome?.pr) || NOT_MERGED.has(outcome?.finalState);
/** A gate `blocking` entry as one string, the shape `--outcomes` takes and hand-written records carry; a field the gate left null is left out. */
const findingLine = ({ category, file, line, summary }) => [category ?? '(blank)', file && (line == null ? file : `${file}:${line}`), summary].filter(Boolean).join(' ');

/** One round's `{verdict, blocking}`: unparseable, or empty beside its `.raw` (`isUnreadableEmpty`), is `blocking` with nothing to list, and is warned about. */
function roundVerdict({ path, review }, blockOn, warn) {
  if (isUnreadableEmpty(path, review)) {
    warn(`${path}: empty beside .raw; read as blocking`);
    return { verdict: 'blocking', blocking: [] };
  }
  try { return gateReview(review, blockOn); } catch (err) {
    warn(`${path}: ${err.message}; read as blocking`);
    return { verdict: 'blocking', blocking: [] };
  }
}

/**
 * Whether `a` and `b` are the same event: `sameRun`, ref, finalState, and failureReason (absent reads as
 * null). Differing `reportId`s make them two only when both are PR-less failures (`implStatus: "error"`),
 * the rows a retry re-runs: every report re-lists the other rows as they stood, so a record with a PR,
 * or a skipped one, recurs unchanged. A hand-written record has no `reportId`, so the rest decides.
 */
const sameRecord = (a, b) => sameRun(a.runId, b.runId) && a.repo === b.repo && a.issue === b.issue
  && a.finalState === b.finalState && (a.failureReason ?? null) === (b.failureReason ?? null)
  && (!a.reportId || !b.reportId || a.reportId === b.reportId || a.implStatus !== 'error' || b.implStatus !== 'error');

/**
 * Derive one telemetry issue record per row of the wave `report` that is terminal for this wave.
 * @param {object} report parsed `<stateDir>/state/reports/<id>.json`
 * @param {object|null} entry this wave's sidecar entry (`findWaveContext`), or null
 * @param {Record<string, object>} digests this wave's failure digests by ref (`<stateDir>/state/failure-digest/`,
 *   rewritten for every row that did not succeed); read only for those rows
 * @param {Record<string, Array<{path: string, review: object|null}>>} rounds each ref's rounds, oldest first
 *   as `reviewRoundFiles` returns them; `review` is the parsed file, null when unparseable
 * @param {Record<string, object>} outcomes per-ref `{pr, hitl, finalState, bounces, findings, tokens}`
 * @param {{existing?: object[], warn?: (m: string) => void, tuningVersion?: unknown, reportId?: string, noCheckRepos?: Iterable<string>}} [opts]
 *   a record matching an `existing` one (or an earlier row's) on `sameRun`, ref, finalState and failureReason is dropped,
 *   unless both are PR-less failures carrying different `reportId`s; `reportId` (the report's file stem) is stamped on each record;
 *   a succeeded row in a `noCheckRepos` repo (no `postSessionCheck`, so the engine ran none) records `ciStatus: "none"`
 * @returns {{records: object[]}}
 * @throws when a terminal row has no `owner/repo#N` ref (`malformed report row`), or exists but no run
 *   id can be determined (no `entry.runId`, no `report.configName`), or (`half-supplied wave`, naming every
 *   ref under each cause and carrying them as `err.noPr` and `err.lastBlocks`) a `succeeded` row has no PR in
 *   the report or the outcomes and no outcome `finalState` of `blocked-hitl`, `deferred` or `error`, or a row
 *   with a PR and no outcome `finalState` has a blocking last round
 */
export function deriveWaveRecords(report, entry, digests, rounds, outcomes, { existing = [], warn = (m) => console.error(m), tuningVersion, reportId = null, noCheckRepos = [] } = {}) {
  const all = Array.isArray(report?.issues) ? report.issues : [];
  for (const r of all) if (!TERMINAL.has(r?.status) && !NOT_YET.has(r?.status)) warn(`${r?.ref}: unknown status ${JSON.stringify(r?.status)}, not recorded`);
  const rows = all.filter((r) => TERMINAL.has(r?.status));
  if (!rows.length) return { records: [] };
  const badRow = rows.find((r) => !REF_RE.test(r.ref ?? ''));
  if (badRow) throw new WaveRefusal('malformed-row', `malformed report row: no owner/repo#N ref: ${JSON.stringify(badRow)}`);
  const noCheck = new Set(noCheckRepos);
  const runId = entry?.runId || runIdFromConfigName(report?.configName);
  if (!runId) throw new WaveRefusal('no-run-id', 'no run id: the wave has no sidecar entry with a runId and the report has no configName');
  const blockOn = entry?.blockOn ?? DEFAULT_BLOCK_ON;
  const version = entry?.tuningVersion ?? tuningVersion ?? loadTuning().version;

  const noPr = rows.filter((r) => r.status === 'succeeded' && !supplied(r, outcomes?.[r.ref])).map((r) => r.ref);
  const lastBlocks = [];

  const seen = [...existing];
  const records = [];
  for (const row of rows) {
    const m = REF_RE.exec(row.ref);
    const outcome = outcomes?.[row.ref] ?? {};
    const planned = (entry?.issues ?? []).find((i) => i.ref === row.ref);
    const pr = isPr(row.prNumber) ? row.prNumber : isPr(outcome.pr) ? outcome.pr : null;
    // Digests are written for non-succeeded rows and never removed, so a succeeded
    // row's digest is a stale one from an earlier wave; and a session that succeeded
    // did not die on quota, whatever the row says.
    const digest = row.status === 'succeeded' ? null : digests?.[row.ref];
    const rateLimited = row.status !== 'succeeded' && (digest?.failureReason ?? row.failureReason) === 'rate-limited';
    const skipped = row.status === 'skipped';
    // One record of this row: `outcome` and `pr` are what the record reads, since a death resumed in place is the
    // row without them, and `dead` whether this record is the rate-limit death.
    const build = (outcome, pr, dead) => {
      // `skipped` never reached implement. `blocked` is not an engine status, but
      // SKILL.md step 5 and the failure-routing tests hand it in as one, so it stays.
      const implStatus = skipped ? null : routeFailure({ ...row, prNumber: pr }) === 'review-gate' ? 'pushed' : row.status === 'blocked' ? 'blocked' : 'error';

      // Only a row the gate reviewed has rounds; older ones on disk are not this row's verdict.
      const refRounds = implStatus === 'pushed' ? rounds?.[row.ref] ?? [] : [];
      const gated = refRounds.map((r) => roundVerdict(r, blockOn, warn));
      const verdicts = gated.map((g) => g.verdict);
      // A round is a bounce when the round before it blocked; a re-gate after a clean
      // round (a rebase moving the base) is not.
      const bounced = verdicts.map((_, i) => i > 0 && verdicts[i - 1] === 'blocking');
      refRounds.forEach((r, i) => {
        const trigger = r.review?.meta?.trigger;
        if (trigger && i > 0 && (trigger === 'review-loop') !== bounced[i]) warn(`${row.ref}: ${r.path} says trigger "${trigger}" but its predecessor ${verdicts[i - 1]}`);
      });
      // The last round blocking with no finalState to say where it went (point B after /review-loop gave up) is not a merge to guess.
      if (verdicts.at(-1) === 'blocking' && !outcome.finalState) lastBlocks.push(row.ref);
      // The latest round at the highest severity that lists something: a later block is what the PR was last
      // held on, and an unreadable round (blocking, nothing listed) does not hide an earlier one's findings.
      const worst = gated.reduce((w, g) => {
        const d = SEVERITY[g.verdict] - SEVERITY[w.verdict];
        return d > 0 || (d === 0 && (g.blocking.length > 0 || w.blocking.length === 0)) ? g : w;
      }, { verdict: 'clean', blocking: [] });
      // Telemetry reads a rate-limit as an infra death beside implStatus "error"; a
      // rate-limited row that still opened a PR (backend#620) is gated, not dead.
      const failureReason = dead && implStatus === 'error' ? 'rate-limited' : null;

      return {
        runId,
        reportId,
        repo: m[1],
        issue: Number(m[2]),
        complexity: planned?.complexity ?? 'normal',
        complexitySource: planned?.complexity ? 'entry' : 'default',
        triageStatus: 'clear',
        assignment: planned?.model ?? null,
        effort: planned?.effort ?? null,
        effortSource: planned?.effortSource ?? null,
        model: planned?.model ?? null,
        path: 'engine',
        implStatus,
        ciStatus: row.status === 'succeeded' && pr ? (noCheck.has(m[1]) ? 'none' : 'pass') : null,
        reviewVerdict: verdicts.length ? worst.verdict : null,
        reviewPath: refRounds.at(-1)?.path ?? null,
        failureReason,
        findings: outcome.findings ?? worst.blocking.map(findingLine),
        bounces: Math.max(outcome.bounces ?? 0, bounced.filter(Boolean).length),
        hitl: { pointA: false, pointB: !!outcome.hitl?.pointB },
        // A quota death is deferred, not abandoned: point E resumes it in place.
        finalState: outcome.finalState ?? (skipped || failureReason ? 'deferred' : pr ? 'merged' : 'error'),
        pr,
        tokens: outcome.tokens ?? null,
        policySource: entry?.blockOn ? 'sidecar' : 'default',
        tuningVersion: version,
        ts: report.finishedAt || report.startedAt,
      };
    };

    // Point E emits the death at death time, apart from the continuation's record: when --outcomes shows a
    // continuation ran (its PR, or the point B it stalled at), the row is the death and the outcome is the
    // continuation, which carries no rate-limit of its own. Without either, the outcome is the death's own, and
    // stays a quota death: one must never read as a model failure.
    const resumed = rateLimited && !isPr(row.prNumber) && (isPr(outcome.pr) || outcome.hitl?.pointB === true);
    const death = resumed ? build({}, null, true) : null;
    const recs = death?.failureReason ? [death, build(outcome, pr, false)] : [build(outcome, pr, rateLimited)];
    for (const rec of recs) {
      if (seen.some((s) => sameRecord(s, rec))) continue;
      seen.push(rec);
      records.push(rec);
    }
  }
  const causes = [
    [noPr, 'succeeded with no PR in the report or --outcomes, and no --outcomes finalState of blocked-hitl, deferred or error'],
    [lastBlocks, 'a PR whose last review round blocks, with no --outcomes finalState'],
  ].filter(([refs]) => refs.length);
  if (causes.length) {
    throw new WaveRefusal('half-supplied', `half-supplied wave: ${causes.map(([refs, why]) => `${why}: ${refs.join(', ')}`).join('; ')}`, { noPr, lastBlocks });
  }
  return { records };
}
