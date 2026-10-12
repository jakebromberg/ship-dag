// wave-records.mjs — derive a wave's telemetry issue records from the engine's own
// artifacts, so emission is a consequence of the wave rather than a reminder.
//
// The caller reads the artifacts and hands in what they hold: the report, the
// wave's routing entry (`waveContextFor`: the sidecar's, else one built from its config), the failure digests, and each ref's
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
import { isPr, parsePr, parseRef, sameRepo } from './ref.mjs';
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
export const TERMINAL = new Set(['succeeded', 'failed', 'blocked', 'skipped']);
const NOT_YET = new Set(['pending', 'running', 'interrupted']);
// A succeeded row is supplied by a PR, in the report or --outcomes, or by an outcome
// saying it never merged: point B left a find-pr row without one.
const NOT_MERGED = new Set(['blocked-hitl', 'deferred', 'error']);
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

/** The `finalState` that identifies an event: a rate-limited `error` is the legacy hand-written spelling of the `deferred` death ingest derives (PR #105). */
const eventState = (r) => (r.failureReason === 'rate-limited' && r.finalState === 'error' ? 'deferred' : r.finalState);

/** Whether two parsed PRs (`parsePr`) are one: both absent, or the same number in the same repo. */
const samePr = (a, b) => (a && b ? a.pr === b.pr && sameRepo(a.repo, b.repo) : a === b);

/** A PR-less failure: a record that reached implement and opened no PR the gate reviewed. */
const prLessFailure = (r) => r.implStatus === 'error' || r.implStatus === 'blocked';

/**
 * Whether records `a` and `b` are the same event: the one identity ingest-wave's dedupe and `rowCovered` both use.
 * They share `sameRun`, ref, `eventState` and failureReason (absent reads as null). Both reached implement or
 * neither did (`implStatus` null); which non-null status a record gives is not compared, so a merge hand-written
 * as `error` or `blocked` is the merge ingest derives as `pushed`. They hold the same PR (`parsePr`: the same number in the same repo, or none), or both are merges
 * (until #107's "ran" facts tell those apart). Differing `reportId`s make two PR-less failures (`error` or
 * `blocked`) two events, since a retry re-runs a failed row, unless both are `blocked`, which no retry re-runs:
 * every report re-lists the other rows as they stood, so a record with a PR, a skipped one or a blocked one
 * recurs unchanged. A hand-written record has no `reportId`, so the rest decides. The engine has no `blocked`
 * status today; if a later run that is not a retry blocked the row again, this fold would read that second block as the first.
 */
export const sameEvent = (a, b) => sameRun(a.runId, b.runId) && sameRepo(a.repo, b.repo) && a.issue === b.issue
  && eventState(a) === eventState(b) && (a.failureReason ?? null) === (b.failureReason ?? null)
  && (a.implStatus == null) === (b.implStatus == null)
  && (samePr(parsePr(a.pr, a.repo), parsePr(b.pr, b.repo)) || (a.finalState === 'merged' && b.finalState === 'merged'))
  && (!a.reportId || !b.reportId || a.reportId === b.reportId || !prLessFailure(a) || !prLessFailure(b)
    || (a.implStatus === 'blocked' && b.implStatus === 'blocked'));

/**
 * The `implStatus` a record of `row` takes when its PR is `pr` (the row's, or one `--outcomes` supplied):
 * `skipped` never reached implement; a row the gate reviews pushed; `blocked` is not an engine status,
 * but SKILL.md step 5 and the failure-routing tests hand it in as one, so it stays.
 */
const implStatusOf = (row, pr) => (row.status === 'skipped' ? null
  : routeFailure({ ...row, prNumber: pr }) === 'review-gate' ? 'pushed' : row.status === 'blocked' ? 'blocked' : 'error');

/**
 * Whether `row` died on quota, as ingest reads it: its failure digest's `failureReason`, else the row's own.
 * Digests are written for non-succeeded rows and never removed, so a succeeded row's digest is a stale one from an
 * earlier wave; and a session that succeeded did not die on quota, whatever the row says.
 */
const rateLimitedRow = (row, digest) => row.status !== 'succeeded' && (digest?.failureReason ?? row.failureReason) === 'rate-limited';

/**
 * Whether `records` (the telemetry log) cover terminal `row` of the report `{id, startedAt (epoch ms)}`, as run
 * `runId`'s family sees it: whether one is, by `sameEvent`, the event this report's ingest would derive for the row.
 * `digest` is the row's failure digest as `telemetry.mjs`'s `waveWindow` reads it for ingest, so the row's rate-limit
 * is the one ingest reads (`rateLimitedRow`), never a record's. Audit reads no `--outcomes`, so each record is tested
 * against the event ingest would derive with the --outcomes it implies: its finalState (but not `merged` for a row
 * with no PR, bar a find-pr row, whose merge has one, and nothing else ingest refuses), and its PR for a find-pr
 * row. A record that carries `id` was derived from this row, so its PR is read as given too, except on a PR-less
 * rate-limit death: ingest resumes one that --outcomes gives a PR or point B as two records, the death and its
 * continuation, and with neither derives the death alone; so only a record of the death covers it, and a
 * continuation without its death does not. A hand-written record (no `reportId`) covers a PR-less failure only at
 * or after `startedAt`: stricter than ingest, which folds a hand-written record into any report's event, since a
 * record that old merits a look. The disagreements this accepts, each a row in the test's one-identity table:
 * - `startedAt`: a row whose only record is a hand-written PR-less failure from before it is named.
 * - `--outcomes`: a row covered by a record of another finalState (a point-B hold of its PR, an operator's
 *   `deferred`) appends under other --outcomes, as the merge that followed the hold does; and a PR-less row whose
 *   PR came from --outcomes is named unless a record carrying `id` holds that PR (or, on a death, the death's record).
 */
export function rowCovered(row, { id, startedAt }, records, runId, digest) {
  const { repo, number } = parseRef(row.ref);
  const findPr = row.status === 'succeeded' && !isPr(row.prNumber);
  const rateLimited = rateLimitedRow(row, digest);
  // Whether a PR-less run of the row is a rate-limit death (a row with a PR is gated, and reads its own PR).
  const dies = rateLimited && implStatusOf(row, null) === 'error';
  return records.some((r) => {
    const rp = isPr(row.prNumber) || !(findPr || (r.reportId === id && !dies)) ? null : parsePr(r.pr, repo);
    // A find-pr row's PR comes from --outcomes: a record whose PR value is no PR holds none of it, unless it is a merge, which
    // folds with any merge (sameEvent). Another repo's PR is told apart by sameEvent, which compares repos.
    if (findPr && r.finalState !== 'merged' && r.pr != null && !rp) return false;
    const pr = isPr(row.prNumber) ? row.prNumber : rp ? rp.pr : null;
    const { finalState } = r;
    // A find-pr row's merge has a PR --outcomes supplied, whether or not the record names it.
    const implStatus = findPr && finalState === 'merged' ? 'pushed' : implStatusOf(row, pr);
    const failureReason = rateLimited && implStatus === 'error' ? 'rate-limited' : null;
    // Every finalState a record can hold is one --outcomes may give a find-pr row.
    const derivable = pr !== null || row.status === 'skipped' || findPr || finalState !== 'merged';
    const event = { runId, repo, issue: number, reportId: id, implStatus, finalState, failureReason, pr };
    return derivable && sameEvent(r, event) && (Boolean(r.reportId) || !prLessFailure(event) || Date.parse(r.ts) >= startedAt);
  });
}

/**
 * Derive one telemetry issue record per row of the wave `report` that is terminal for this wave.
 * @param {object} report parsed `<stateDir>/state/reports/<id>.json`
 * @param {object|null} entry this wave's routing entry (`waveContextFor`'s `entry`: the sidecar's, else one built from its config), or null
 * @param {Record<string, object>} digests this wave's failure digests by ref (`<stateDir>/state/failure-digest/`,
 *   rewritten for every row that did not succeed); read only for those rows
 * @param {Record<string, Array<{path: string, review: object|null}>>} rounds each ref's rounds, oldest first
 *   as `reviewRoundFiles` returns them; `review` is the parsed file, null when unparseable
 * @param {Record<string, object>} outcomes per-ref `{pr, hitl, finalState, bounces, findings, tokens}`
 * @param {{existing?: object[], warn?: (m: string) => void, tuningVersion?: unknown, reportId?: string, noCheckRepos?: Iterable<string>}} [opts]
 *   a record that is the same event as an `existing` one (or an earlier row's), by `sameEvent`, is dropped; `reportId` (the report's file stem) is stamped on each record;
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
  const badRow = rows.find((r) => !parseRef(r.ref));
  if (badRow) throw new WaveRefusal('malformed-row', `malformed report row: no owner/repo#N ref: ${JSON.stringify(badRow)}`);
  // The entry and noCheckRepos are the routing matched to these refs as written (waveContextMatches), so they are looked up exactly.
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
    const m = parseRef(row.ref);
    const outcome = outcomes?.[row.ref] ?? {};
    const planned = (entry?.issues ?? []).find((i) => i.ref === row.ref);
    const pr = isPr(row.prNumber) ? row.prNumber : isPr(outcome.pr) ? outcome.pr : null;
    const rateLimited = rateLimitedRow(row, digests?.[row.ref]);
    const skipped = row.status === 'skipped';
    // One record of this row: `outcome` and `pr` are what the record reads, since a death resumed in place is the
    // row without them, and `dead` whether this record is the rate-limit death.
    const build = (outcome, pr, dead) => {
      const implStatus = implStatusOf(row, pr);

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
        repo: m.repo,
        issue: m.number,
        complexity: planned?.complexity ?? 'normal',
        complexitySource: planned?.complexity ? 'entry' : 'default',
        triageStatus: 'clear',
        assignment: planned?.model ?? null,
        effort: planned?.effort ?? null,
        effortSource: planned?.effortSource ?? null,
        model: planned?.model ?? null,
        path: 'engine',
        implStatus,
        ciStatus: row.status === 'succeeded' && pr ? (noCheck.has(m.repo) ? 'none' : 'pass') : null,
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
      if (seen.some((s) => sameEvent(s, rec))) continue;
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
