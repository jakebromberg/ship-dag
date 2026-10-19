// stage.mjs — a ticket's stage, read from the files the engine and the review
// gate already write, so the board never shows a hand-written stage that the
// engine has since contradicted.
//
// Nothing here is new bookkeeping: the engine's status and metadata files, its
// wave reports, and the review files step 4d writes. Paths come from the same
// helpers diagnose-failure.mjs uses (lib/failure.mjs). The run family, which report owns a ref
// and which files are its review rounds, in which order, come from the shared
// readers in lib/ (`runFamilyStateDirs`, `reportOwnership`, `reviewRoundFiles`),
// so the board, ingest and diagnose-failure read them one way. A review is
// scored by the gate's own `gateReview` (through `classifyRound`), so the board and the merge gate cannot
// disagree about what blocks.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { routeFailure, statusPathForRef, metadataPathForRef } from '../lib/failure.mjs';
import { reviewRoundFiles, classifyRound } from '../lib/review-rounds.mjs';
import { readWaveReports, reportOwnership, runFamilyStateDirs } from '../lib/wave-reports.mjs';
import { isPr } from '../lib/ref.mjs';

/** The engine stage labels `deriveStage` returns; render.mjs keys the chip colours (`STAGE_STATUS`) on them. */
export const STAGES = Object.freeze({
  building: 'Building',
  stalled: 'Stalled',
  inReview: 'In review',
  fixing: 'Fixing',
  reviewed: 'Reviewed',
  unreadable: 'Review unreadable',
});

const readText = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const mtimeMs = (path) => { try { return statSync(path).mtimeMs; } catch { return NaN; } };

/**
 * Read a run family once, for every `deriveStage` call of one render: its dirs
 * (`runFamilyStateDirs`) and which of its reports owns each ref
 * (`reportOwnership` over every family dir's `readWaveReports`).
 * @param {string} dir  any dir of the run family
 * @param {{warn?: (m: string) => void, dirs?: string[]}} [opts]  where an unreadable report or family listing is
 *   warned about; `dirs`, the family already listed (`runFamilyStateDirs`)
 * @returns {{dirs: string[], ownership: ReturnType<typeof reportOwnership>}}
 */
export function readFamily(dir, { dirs, ...opts } = {}) {
  dirs ??= runFamilyStateDirs(dir, opts);
  return { dirs, ownership: reportOwnership(dirs.flatMap((d) => readWaveReports(d, opts))) };
}

/**
 * Derive a ticket's stage, or null when the files say nothing about it. First
 * match wins:
 *  - `running`: **Building**, unless the report that owns the ref started at or
 *    after `waveTs` and finished (else started) at or after the session that
 *    wrote `running` launched — the engine writes a report only when a run
 *    finishes, so that means the session died and the ticket is **Stalled**.
 *    The launch is `metadata.startedAt`, which the engine writes at each launch
 *    right after `running`; only when it is missing or unparseable is the status
 *    file's mtime used, since a copy or restore that loses mtimes moves it. A
 *    report that finished before the launch is an earlier session's (the wave's
 *    first run, before a retry in a `-b` dir or in place), so it never stalls
 *    the ticket.
 *  - `failed`/`interrupted` with no PR (`routeFailure`, given the open PR's number, else `metadata.prNumber`), or whose PR is not
 *    open (the engine never clears a stale `metadata.prNumber`): **Stalled**.
 *  - no open PR: null.
 *  - an open PR and no review round of its PR: **In review**. A round stamped
 *    (`meta.reportId`) with a report whose row for the ref has a PR other than
 *    the open PR's number (`openPr`, else `metadata.prNumber` when the caller
 *    has none) reviewed that older PR, so it is skipped. A round with no stamp,
 *    or whose stamp names no report listing the ref, is still being written: it
 *    counts only when its mtime is at or after the owning report's `startedAt`
 *    (telemetry's `waveWindow` rule), and every one counts when no report owns
 *    the ref. A round stamped with a report whose row has no PR counts (a
 *    point-E continuation's or a resource resume's rounds carry the death
 *    report's id, even when a later report owns the ref).
 *  - the newest such round, as `reviewRoundFiles` orders them, scored with
 *    `gateReview` under the run's `--block-on`: blocking → **Fixing**; otherwise
 *    **Reviewed** (never "ready to merge": the board can't run the gate's
 *    arrival check); an empty findings array beside a `.raw` sibling, or
 *    anything unreadable → **Review unreadable**.
 *
 * @param {object} a
 * @param {string} a.dir  the dir holding this ticket's latest wave (its `state/`)
 * @param {string} a.ref  composite ref
 * @param {number} a.waveTs  the launch time (ms since epoch) of the ticket's latest wave: a report that started
 *   earlier is an earlier wave's and never stalls the ticket. Retries within the wave are told apart by
 *   `metadata.startedAt`, not by this.
 * @param {ReturnType<typeof readFamily>} a.family  the run family, as `readFamily` reads it
 * @param {string[]} a.blockOn  the run's parsed `--block-on`
 * @param {boolean} a.prOpen  whether the ticket has an open PR
 * @param {number} [a.openPr]  that open PR's number, which a stamped round's report row is compared against;
 *   `metadata.prNumber` stands in when the caller has none
 * @returns {string|null} one of the `STAGES` values, or null
 */
export function deriveStage({ dir, ref, waveTs, family, blockOn, prOpen, openPr }) {
  const status = (readText(statusPathForRef(dir, ref)) || 'pending').trim();
  const metadata = readJson(metadataPathForRef(dir, ref)) || {};
  const { ownerOf, rowOf } = family.ownership;
  if (status === 'running') {
    const owner = ownerOf(ref);
    if (!owner || owner.startedAt < waveTs) return STAGES.building;
    const finishedAt = Date.parse(owner.report.finishedAt ?? '');
    const reportEnd = Number.isFinite(finishedAt) ? finishedAt : owner.startedAt;
    // The engine writes metadata.startedAt at each launch, right after `running`; the mtime is only a fallback.
    const launched = Date.parse(metadata.startedAt ?? '');
    const sessionStart = Number.isFinite(launched) ? launched : mtimeMs(statusPathForRef(dir, ref));
    return reportEnd < sessionStart ? STAGES.building : STAGES.stalled;
  }
  const current = openPr ?? metadata.prNumber;
  if ((status === 'failed' || status === 'interrupted') && (!prOpen || routeFailure({ status, prNumber: current }) !== 'review-gate')) {
    return STAGES.stalled;
  }
  if (!prOpen) return null;
  const since = ownerOf(ref)?.startedAt ?? -Infinity;
  const notThisPr = ({ mtimeMs }, stamp) => {
    const row = stamp ? rowOf(stamp, ref) : null;
    if (!row) return !(mtimeMs >= since);
    return isPr(row.prNumber) && row.prNumber !== current;
  };
  // The newest round is the PR's current state; ingestion, not the board, takes the worst.
  const latest = reviewRoundFiles(family.dirs.map((d) => join(d, 'reviews')), ref)
    .map((file) => ({ ...file, review: readJson(file.path) }))
    .findLast((file) => !notThisPr(file, file.review?.meta?.reportId));
  return latest ? scoreReview({ path: latest.path, review: latest.review }, blockOn) : STAGES.inReview;
}

function scoreReview(round, blockOn) {
  const { unreadable, verdict } = classifyRound(round, blockOn);
  return unreadable ? STAGES.unreadable : verdict === 'blocking' ? STAGES.fixing : STAGES.reviewed;
}
