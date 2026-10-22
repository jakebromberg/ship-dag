// wave-records.mjs — derive a wave's telemetry issue records from the engine's own
// artifacts, so emission is a consequence of the wave rather than a reminder.
//
// The caller reads the artifacts and hands in what they hold: the report, the
// wave's routing entry (`waveContextFor`: the sidecar's, else one built from its config), the failure digests, and each ref's
// review rounds as `reviewRoundFiles` lists them (oldest first: by round number, else mtime), each
// file parsed. Only `--outcomes` supplies what no artifact records: `hitl.pointB`,
// a manual `finalState`, a PR the report row lacks, a floor for `bounces`, and
// `pressureOverride` (point F's "start anyway"; on a resumed rate-limit death it lands on the death record, the
// invocation that ran under the override, not on the continuation).
//
// Beyond its arguments it touches two things: `classifyRound` checks each
// round's path for a `.raw` sibling (one rule for the #2587 signature, kept in
// review-rounds.mjs), and `references/tuning.json` is loaded once, only when
// neither the entry nor `opts.tuningVersion` gives a tuning version.
//
// A row is recorded once it is terminal for this wave (`succeeded`, `failed`,
// `blocked`, `skipped`): `pending`, `running` and `interrupted` rows are left for
// the ingest that sees them finish, and any other status is warned about and skipped.
// The exception is a `pending` row the engine stopped at launch, or never launched before it died (a `RESOURCE_ROUTE` failureReason): it is
// recorded only once `--outcomes` gives it a `finalState`, because the user deferred it or stopped the run.
import { DEFAULT_BLOCK_ON } from '../review-gate.mjs';
import { INFRA_REASONS, RESOURCE_ROUTE, ranOf, routeFailure, SKIP_REASON_DEPENDENCY } from './failure.mjs';
import { isPr, parsePr, parseRef, sameRepo } from './ref.mjs';
import { classifyRound } from './review-rounds.mjs';
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
/** A `pending` row the engine stopped at launch: never started, so it is not yet terminal unless `--outcomes` ends it. */
const stoppedAtLaunch = (row, outcome) => row?.status === 'pending' && RESOURCE_ROUTE.has(row.failureReason) && Boolean(outcome?.finalState);
// A succeeded row is supplied by a PR, in the report or --outcomes, or by an outcome
// saying it never merged: point B left a find-pr row without one.
const NOT_MERGED = new Set(['blocked-hitl', 'deferred', 'error']);
const supplied = (row, outcome) => isPr(row.prNumber) || isPr(outcome?.pr) || NOT_MERGED.has(outcome?.finalState);
/** A gate `blocking` entry as one string, the shape `--outcomes` takes and hand-written records carry, and the `summary` of a derived finding; a field the gate left null is left out. */
const findingLine = ({ category, file, line, summary }) => [category ?? '(blank)', file && (line == null ? file : `${file}:${line}`), summary].filter(Boolean).join(' ');

/** One round's `{verdict, blocking}` (`classifyRound`): an unreadable round is `blocking` with nothing to list, and is warned about. */
function roundVerdict(round, blockOn, warn) {
  const gated = classifyRound(round, blockOn);
  if (gated.unreadable) warn(`${round.path}: ${gated.unreadable}; read as blocking`);
  return gated;
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
 * as `error` or `blocked` is the merge ingest derives as `pushed`. They hold the same PR (`parsePr`: the same number in the same repo, or none), or both are merges.
 * Records of different reports (both carry a `reportId`, and they differ) are told apart by `ran`, the report row's
 * own fact, which a derived record carries. Once either carries it, they are two events: a derived record is its
 * report's own event, since a row a later report only carries over derives none (`carriedOver`). Neither carrying it (a record from before
 * `ran`), two PR-less failures (`error` or `blocked`) are two events, since a retry re-runs a failed row, unless both are
 * `blocked`, which no retry re-runs: every report re-lists the other rows as they stood, so a record with a PR, a skipped one or a blocked one
 * recurs unchanged. A hand-written record has no `reportId`, so the rest decides.
 */
export const sameEvent = (a, b) => sameRun(a.runId, b.runId) && sameRepo(a.repo, b.repo) && a.issue === b.issue
  && eventState(a) === eventState(b) && (a.failureReason ?? null) === (b.failureReason ?? null)
  && (a.implStatus == null) === (b.implStatus == null)
  && (samePr(parsePr(a.pr, a.repo), parsePr(b.pr, b.repo)) || (a.finalState === 'merged' && b.finalState === 'merged'))
  && (!a.reportId || !b.reportId || a.reportId === b.reportId
    || (a.ran == null && b.ran == null && (!prLessFailure(a) || !prLessFailure(b) || (a.implStatus === 'blocked' && b.implStatus === 'blocked'))));

/**
 * The `implStatus` a record of `row` takes when its PR is `pr` (the row's, or one `--outcomes` supplied):
 * `skipped` and a `pending` launch stop never reached implement; a row the gate reviews pushed; `blocked` is not an engine status,
 * but SKILL.md step 5 and the failure-routing tests hand it in as one, so it stays.
 */
const implStatusOf = (row, pr) => (row.status === 'skipped' || row.status === 'pending' ? null
  : routeFailure({ ...row, prNumber: pr }) === 'review-gate' ? 'pushed' : row.status === 'blocked' ? 'blocked' : 'error');

/**
 * Whether `row` is one a report only carries over: it launched no session (`ran: false`) and an `earlier` report of
 * the run family (parsed reports, as `readWaveReports` reads them) lists the same ref with the same status and PR.
 * Any other `ran: false` row is its own pre-launch event. A failure that a retry re-runs (a row that did not succeed
 * and has no PR the gate reviews, `implStatus` `error`) is never carried over: a repeated worktree-setup failure is that
 * report's own. A succeeded row with no PR (a find-pr merge, which `implStatusOf` also reads as `error`) is no failure,
 * and a `blocked` row, which no retry re-runs, is carried over like any other. A `ran` that is not a boolean is no fact (`ranOf`).
 */
export const carriedOver = (row, earlier = []) => {
  const pr = isPr(row.prNumber) ? row.prNumber : null;
  return ranOf(row) === false && (row.status === 'succeeded' || implStatusOf(row, pr) !== 'error')
    && earlier.some((rep) => rep?.issues?.some((r) => r?.ref === row.ref && r.status === row.status && (isPr(r.prNumber) ? r.prNumber : null) === pr));
};

/**
 * Why `row` stopped for infrastructure, as ingest reads it: its failure digest's `failureReason`, else the row's own,
 * when that is one of `INFRA_REASONS`; else null.
 * Digests are written for non-succeeded rows and never removed, so a succeeded row's digest is a stale one from an
 * earlier wave; and a session that succeeded did not die on quota, whatever the row says.
 */
const stopReasonOf = (row, digest) => {
  const reason = digest?.failureReason ?? row.failureReason;
  return row.status !== 'succeeded' && INFRA_REASONS.has(reason) ? reason : null;
};
/**
 * Whether `r` is this report's record of an engine-died row ingested before `"engine-died"` was an infra reason: a model
 * error (`error`/`error`, no reason) of the same report. The log is never rewritten (#286), so audit takes it as the death;
 * ingest still derives the death, a superseding record appended only with the maintainer's approval.
 */
const legacyDeath = (r, event) => event.failureReason === 'engine-died' && Boolean(event.reportId) && r.reportId === event.reportId
  && sameRun(r.runId, event.runId) && sameRepo(r.repo, event.repo) && r.issue === event.issue
  && r.implStatus === 'error' && r.finalState === 'error' && r.failureReason == null;
/** The `at` of each of `row`'s `engineDeaths` (claude-orchestrator#315), sorted oldest first; an entry with no readable `at` is warned about and skipped. */
const engineDeathsOf = (row, warn = () => {}) => (Array.isArray(row?.engineDeaths) ? row.engineDeaths : []).flatMap((d) => {
  if (Number.isFinite(Date.parse(d?.at))) return [d.at];
  warn(`${row.ref}: engineDeaths entry ${JSON.stringify(d)} has no readable at, not recorded`);
  return [];
}).sort((a, b) => Date.parse(a) - Date.parse(b));
/**
 * A predicate: whether a record is the death of one of `row`'s markers, an `engine-died` record dated by its `at`. That death
 * is an earlier run's, never the row's own event, which sameEvent (blind to `ts`) cannot tell, nor its sessions.
 */
export const markerDeathOf = (row) => {
  const times = new Set(engineDeathsOf(row).map(Date.parse));
  return (rec) => rec.failureReason === 'engine-died' && times.has(Date.parse(rec.ts));
};
/**
 * The run a marker dated `at` followed, of `runs` (the config's reports for a row, as `runsOf` builds them): the latest to
 * start before the marker, if it started after the row's previous marker `prevAt` (undefined for the first); else undefined. A
 * run starts after the engine writes the markers it finds, so its `startedAt` bounds it whatever a rebuild set `finishedAt`
 * to, and a later relaunch that wrote no marker is still the run this one followed. A relaunch that wrote no report at all
 * is no run here: a marker that lists only its death, not the one before, is taken for the earlier run's (a known limit).
 */
const diedBefore = (runs, at, prevAt) => {
  const died = runs.filter((r) => r.start < at).reduce((a, r) => (a && a.start >= r.start ? a : r), null);
  return died && died.start > (prevAt === undefined ? -Infinity : Date.parse(prevAt)) ? died : undefined;
};
/** Whether `s` is an `engine-died` record of the row of `rec`, dated `t`. */
const diedAtOf = (s, rec, t) => s.failureReason === 'engine-died' && s.issue === rec.issue && sameRepo(s.repo, rec.repo) && sameRun(s.runId, rec.runId) && Date.parse(s.ts) === t;
/**
 * Whether the death `rec` of a marker dated `rec.ts`, whose row's previous marker is dated `prevAt`, is held elsewhere.
 * The engine writes a marker when it next starts, after the run that died (`diedBefore`). When that run's report stamped
 * the row `engine-died` with `implStatus` error (a stamped row that kept a PR is gated, and derives no death), the death is that report's own record, which its ingest derives with its id and the dead run's sessions (or, before
 * #286, derived as a model error that `legacyDeath` names), whichever report is ingested first; until it is, audit names
 * that report's row. Else it is a record in `records` of the same row dated by the same `at` (a later report re-lists every
 * marker), or the run that died's own `engine-died` record. Another config keeps its own markers.
 */
const deathHeld = (records, rec, prevAt, runs) => {
  const died = diedBefore(runs, Date.parse(rec.ts), prevAt);
  return Boolean(died?.stamped) || records.some((s) => diedAtOf(s, rec, Date.parse(rec.ts)) || (died && diedAtOf(s, rec, died.ts)));
};
/**
 * Whether `records` hold the marker death of `rec`, a stamped death of the report `runs[0]`: a later report ingested first
 * listed it as a marker, dated by its `at`. Only a log appended before `deathHeld` deferred to the stamped report holds one;
 * the log is never rewritten, so the death stays that one record.
 */
const heldByMarker = (records, rec, runs) => runs.some((l) => l.markers.some((at, i) => diedBefore(runs, Date.parse(at), l.markers[i - 1]) === runs[0]
  && records.some((s) => diedAtOf(s, rec, Date.parse(at)))));
/** Whether a row with `implStatus` carries its stop as the record's `failureReason`: a death, or a launch stop that never started. */
const diesWith = (row, implStatus) => implStatus === 'error' || row.status === 'pending';

/**
 * Whether `records` (the telemetry log) cover terminal `row` of the report `{id, startedAt (epoch ms)}`, as run
 * `runId`'s family sees it: whether one is, by `sameEvent`, the event this report's ingest would derive for the row.
 * `digest` is the row's failure digest as `telemetry.mjs`'s `waveWindow` reads it for ingest, so the row's stop
 * is the one ingest reads (`stopReasonOf`), never a record's. `earlier` is the run family's earlier parsed reports (`carriedOver`): a
 * carried-over row derives none of its own, so a record of the earlier event covers it. Audit reads no `--outcomes`, so each record is tested
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
export function rowCovered(row, { id, startedAt }, records, runId, digest, earlier = []) {
  const { repo, number } = parseRef(row.ref);
  const findPr = row.status === 'succeeded' && !isPr(row.prNumber);
  const stopReason = stopReasonOf(row, digest);
  const carried = carriedOver(row, earlier);
  // Whether a PR-less run of the row is the death of a stop (a row with a PR is gated, and reads its own PR).
  const dies = stopReason && implStatusOf(row, null) === 'error';
  const markerDeath = markerDeathOf(row);
  return records.some((r) => {
    if (markerDeath(r)) return false;
    const rp = isPr(row.prNumber) || !(findPr || (r.reportId === id && !dies)) ? null : parsePr(r.pr, repo);
    // A find-pr row's PR comes from --outcomes: a record whose PR value is no PR holds none of it, unless it is a merge, which
    // folds with any merge (sameEvent). Another repo's PR is told apart by sameEvent, which compares repos.
    if (findPr && r.finalState !== 'merged' && r.pr != null && !rp) return false;
    const pr = isPr(row.prNumber) ? row.prNumber : rp ? rp.pr : null;
    const { finalState } = r;
    // A find-pr row's merge has a PR --outcomes supplied, whether or not the record names it.
    const implStatus = findPr && finalState === 'merged' ? 'pushed' : implStatusOf(row, pr);
    const failureReason = stopReason && diesWith(row, implStatus) ? stopReason : null;
    // Every finalState a record can hold is one --outcomes may give a find-pr row.
    const derivable = pr !== null || row.status === 'skipped' || findPr || finalState !== 'merged';
    const event = { runId, repo, issue: number, reportId: carried ? null : id, ran: ranOf(row), implStatus, finalState, failureReason, pr };
    return (derivable && sameEvent(r, event) && (Boolean(r.reportId) || !prLessFailure(event) || Date.parse(r.ts) >= startedAt))
      || legacyDeath(r, event);
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
 * @param {Record<string, object>} outcomes per-ref `{pr, hitl, finalState, bounces, findings, tokens, pressureOverride}`
 * @param {{existing?: object[], warn?: (m: string) => void, tuningVersion?: unknown, reportId?: string, noCheckRepos?: Iterable<string>, earlier?: object[], later?: object[]}} [opts]
 *   a record that is the same event as an `existing` one (or an earlier row's), by `sameEvent`, is dropped; `reportId` (the report's file stem) is stamped on each record;
 *   a row `carriedOver` by an `earlier` report (the run family's earlier parsed reports, each with its `reportId`) derives none, and `later` (the later ones) tells a stamped death a later report's marker recorded in a log appended before a marker deferred to it; each record carries its row's `ran` when it is a boolean;
 *   a succeeded row in a `noCheckRepos` repo (no `postSessionCheck`, so the engine ran none) records `ciStatus: "none"`
 * @returns {{records: object[]}}
 * @throws when a terminal row has no `owner/repo#N` ref (`malformed report row`), or exists but no run
 *   id can be determined (no `entry.runId`, no `report.configName`), or (`half-supplied wave`, naming every
 *   ref under each cause and carrying them as `err.noPr` and `err.lastBlocks`) a `succeeded` row that is not `carriedOver` has no PR in
 *   the report or the outcomes and no outcome `finalState` of `blocked-hitl`, `deferred` or `error`, or a row
 *   with a PR and no outcome `finalState` has a blocking last round
 */
export function deriveWaveRecords(report, entry, digests, rounds, outcomes, { existing = [], warn = (m) => console.error(m), tuningVersion, reportId = null, noCheckRepos = [], earlier = [], later = [] } = {}) {
  const all = Array.isArray(report?.issues) ? report.issues : [];
  for (const r of all) if (!TERMINAL.has(r?.status) && !NOT_YET.has(r?.status)) warn(`${r?.ref}: unknown status ${JSON.stringify(r?.status)}, not recorded`);
  const rows = all.filter((r) => TERMINAL.has(r?.status) || stoppedAtLaunch(r, outcomes?.[r?.ref]));
  if (!rows.length) return { records: [] };
  const badRow = rows.find((r) => !parseRef(r.ref));
  if (badRow) throw new WaveRefusal('malformed-row', `malformed report row: no owner/repo#N ref: ${JSON.stringify(badRow)}`);
  // The entry and noCheckRepos are the routing matched to these refs as written (waveContextMatches), so they are looked up exactly.
  const noCheck = new Set(noCheckRepos);
  const runId = entry?.runId || runIdFromConfigName(report?.configName);
  if (!runId) throw new WaveRefusal('no-run-id', 'no run id: the wave has no sidecar entry with a runId and the report has no configName');
  const blockOn = entry?.blockOn ?? DEFAULT_BLOCK_ON;
  const version = entry?.tuningVersion ?? tuningVersion ?? loadTuning().version;

  const noPr = rows.filter((r) => r.status === 'succeeded' && !carriedOver(r, earlier) && !supplied(r, outcomes?.[r.ref])).map((r) => r.ref);
  const lastBlocks = [];

  const seen = [...existing];
  const records = [];
  // Each run of this config, this report's first, then the earlier and later ones': its id, when it started, how its records are
  // dated, whether it stamped `ref`'s row engine-died, and the markers that row lists. A stamped death of one is what a marker records.
  const runsOf = (ref) => [{ ...report, reportId }, ...earlier, ...later].filter((r) => r?.configName === report?.configName).map((r) => {
    const row = (Array.isArray(r.issues) ? r.issues : []).find((i) => i?.ref === ref);
    return { id: r.reportId, start: Date.parse(r.startedAt || r.finishedAt), ts: Date.parse(r.finishedAt || r.startedAt), stamped: row?.failureReason === 'engine-died' && implStatusOf(row, isPr(row.prNumber) ? row.prNumber : null) === 'error', markers: engineDeathsOf(row) };
  });
  for (const row of rows) {
    const runs = runsOf(row.ref);
    const m = parseRef(row.ref);
    const outcome = outcomes?.[row.ref] ?? {};
    const planned = (entry?.issues ?? []).find((i) => i.ref === row.ref);
    const pr = isPr(row.prNumber) ? row.prNumber : isPr(outcome.pr) ? outcome.pr : null;
    const stopReason = stopReasonOf(row, digests?.[row.ref]);
    const skipped = row.status === 'skipped';
    // One record of this row: `outcome` and `pr` are what the record reads, since a death resumed in place is the
    // row without them, and `reason` the stop (`stopReasonOf`) this record is the death of, if any. `diedAt` makes it
    // the death of an `engineDeaths` marker: whatever the row went on to do, a death never reached the gate.
    const build = (outcome, pr, reason, diedAt) => {
      const implStatus = diedAt ? 'error' : implStatusOf(row, pr);

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
      // Telemetry reads a stop as an infra death beside implStatus "error" (or a launch stop that never started); a
      // stopped row that still opened a PR (backend#620) is gated, not dead.
      const failureReason = diedAt ? 'engine-died' : reason && diesWith(row, implStatus) ? reason : null;

      return {
        runId,
        reportId,
        ...(ranOf(row) !== undefined && { ran: ranOf(row) }),
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
        // Each derived finding is an `isFindingObject` (scripts/lib/finding.mjs).
        findings: outcome.findings ?? worst.blocking.map((b) => ({ category: b.category, verdict: b.verdict, summary: findingLine(b) })),
        bounces: Math.max(outcome.bounces ?? 0, bounced.filter(Boolean).length),
        hitl: { pointA: false, pointB: !!outcome.hitl?.pointB },
        // A stop is deferred, not abandoned: point E resumes it in place, or a filtered re-run starts it afresh.
        finalState: outcome.finalState ?? (skipped || failureReason ? 'deferred' : pr ? 'merged' : 'error'),
        pr,
        // Names the engine as the one that deferred it (checkDeps); an unmarked deferral is a maintainer's.
        ...(skipped && !diedAt && { skipReason: SKIP_REASON_DEPENDENCY }),
        tokens: outcome.tokens ?? null,
        // Stamped when the user chose point F's "start anyway" for this wave's engine invocation.
        ...(outcome.pressureOverride === true && { pressureOverride: true }),
        policySource: entry?.blockOn ? 'sidecar' : 'default',
        tuningVersion: version,
        ts: diedAt ?? (report.finishedAt || report.startedAt),
      };
    };

    // The engine's own record of each death (`engineDeaths`, claude-orchestrator#315) is the canonical death channel. Each
    // marker is an earlier death than this report's own, so a stamped row's own death is recorded beside them, never folded in.
    const ats = engineDeathsOf(row, warn);
    ats.forEach((diedAt, i) => {
      const rec = build({}, null, null, diedAt);
      if (deathHeld(seen, rec, ats[i - 1], runs)) return;
      seen.push(rec);
      records.push(rec);
    });
    const markerDeath = markerDeathOf(row);
    // A row a later report only carries over is its earlier report's event, which that report's ingest records, with its cost.
    if (carriedOver(row, earlier)) continue;
    // Point E emits the death at death time, apart from the continuation's record: when --outcomes shows a
    // continuation ran (its PR, or the point B it stalled at), the row is the death and the outcome is the
    // continuation, which carries no stop of its own. Without either, the outcome is the death's own, and
    // stays a stop: one must never read as a model failure.
    const resumed = stopReason && !isPr(row.prNumber) && (isPr(outcome.pr) || outcome.hitl?.pointB === true);
    // pressureOverride belongs to the engine invocation that ran under the override, which is the session that
    // died; the continuation is a later resume (point E) started without CO_PRESSURE_OVERRIDE, so it never carries it.
    const death = resumed ? build({ pressureOverride: outcome.pressureOverride }, null, stopReason) : null;
    const { pressureOverride: _ranUnderOverride, ...continuation } = outcome;
    const own = death?.failureReason ? [death, build(continuation, pr, null)] : [build(outcome, pr, stopReason)];
    for (const rec of own) {
      if (seen.some((s) => !markerDeath(s) && sameEvent(s, rec)) || (rec.failureReason === 'engine-died' && heldByMarker(seen, rec, runs))) continue;
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
