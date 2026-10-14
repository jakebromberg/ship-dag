// stage.mjs — a ticket's stage, read from the files the engine and the review
// gate already write, so the board never shows a hand-written stage that the
// engine has since contradicted.
//
// Nothing here is new bookkeeping: the engine's status and metadata files, its
// wave reports, and the review files step 4d writes. Paths come from the same
// helpers diagnose-failure.mjs uses. The run family, which report owns a ref
// and which files are its review rounds, in which order, come from the shared
// readers in lib/ (`runFamilyStateDirs`, `reportOwnership`, `reviewRoundFiles`),
// so the board, ingest and diagnose-failure read them one way. A review is
// scored by the gate's own `gateReview`, so the board and the merge gate cannot
// disagree about what blocks.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { statusPathForRef, metadataPathForRef } from '../diagnose-failure.mjs';
import { routeFailure } from '../lib/failure.mjs';
import { reviewRoundFiles, isUnreadableEmpty } from '../lib/review-rounds.mjs';
import { readRunFamilyReports, reportOwnership, runFamilyStateDirs } from '../lib/wave-reports.mjs';
import { isPr } from '../lib/ref.mjs';
import { gateReview } from '../review-gate.mjs';

const readText = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

/**
 * Read a run family once, for every `deriveStage` call of one render: its dirs
 * (`runFamilyStateDirs`) and which of its reports owns each ref
 * (`reportOwnership` over `readRunFamilyReports`).
 * @param {string} dir  any dir of the run family
 * @param {{warn?: (m: string) => void}} [opts]  where an unreadable report or family listing is warned about
 * @returns {{dirs: string[], ownership: ReturnType<typeof reportOwnership>}}
 */
export function readFamily(dir, opts) {
  return { dirs: runFamilyStateDirs(dir, opts), ownership: reportOwnership(readRunFamilyReports(dir, opts)) };
}

/**
 * Derive a ticket's stage, or null when the files say nothing about it. First
 * match wins:
 *  - `running`: **Building**, unless the report that owns the ref started at or
 *    after the wave launched — the engine writes a report only when a run
 *    finishes, so that means the session died and the ticket is **Stalled**.
 *  - `failed`/`interrupted` with no PR (`routeFailure`): **Stalled**.
 *  - no open PR: null.
 *  - an open PR and no review round of its PR: **In review**. A round stamped
 *    (`meta.reportId`) with a report whose row for the ref has a PR other than
 *    the ticket's current one (`metadata.prNumber`) reviewed that older PR, so it
 *    is skipped. Every other round counts: an unstamped one, one whose stamp
 *    names no report listing the ref, and one stamped with a report whose row has
 *    no PR (a point-E continuation's or a resource resume's rounds carry the
 *    death report's id, even when a later report owns the ref).
 *  - the newest such round, as `reviewRoundFiles` orders them, scored with
 *    `gateReview` under the run's `--block-on`: blocking → **Fixing**; otherwise
 *    **Reviewed** (never "ready to merge": the board can't run the gate's
 *    arrival check); an empty findings array beside a `.raw` sibling, or
 *    anything unreadable → **Review unreadable**.
 *
 * @param {object} a
 * @param {string} a.dir  the dir holding this ticket's latest wave (its `state/`)
 * @param {string} a.ref  composite ref
 * @param {number} a.waveTs  when that wave launched (ms since epoch)
 * @param {ReturnType<typeof readFamily>} a.family  the run family, as `readFamily` reads it
 * @param {string[]} a.blockOn  the run's parsed `--block-on`
 * @param {boolean} a.prOpen  whether the ticket has an open PR
 * @returns {'Building'|'Stalled'|'In review'|'Fixing'|'Reviewed'|'Review unreadable'|null}
 */
export function deriveStage({ dir, ref, waveTs, family, blockOn, prOpen }) {
  const status = (readText(statusPathForRef(dir, ref)) || 'pending').trim();
  const metadata = readJson(metadataPathForRef(dir, ref)) || {};
  const { ownerOf, rowOf } = family.ownership;
  if (status === 'running') {
    const owner = ownerOf(ref);
    return owner && owner.startedAt >= waveTs ? 'Stalled' : 'Building';
  }
  if ((status === 'failed' || status === 'interrupted') && routeFailure({ status, prNumber: metadata.prNumber }) !== 'review-gate') {
    return 'Stalled';
  }
  if (!prOpen) return null;
  const olderPr = (stamp) => {
    const pr = stamp ? rowOf(stamp, ref)?.prNumber : null;
    return isPr(pr) && pr !== metadata.prNumber;
  };
  // The newest round is the PR's current state; ingestion, not the board, takes the worst.
  const latest = reviewRoundFiles(family.dirs.map((d) => join(d, 'reviews')), ref)
    .map(({ path }) => ({ path, review: readJson(path) }))
    .findLast(({ review }) => !olderPr(review?.meta?.reportId));
  return latest ? scoreReview(latest, blockOn) : 'In review';
}

function scoreReview({ path, review }, blockOn) {
  if (!review) return 'Review unreadable';
  if (isUnreadableEmpty(path, review)) return 'Review unreadable';
  try {
    return gateReview(review, blockOn).verdict === 'blocking' ? 'Fixing' : 'Reviewed';
  } catch {
    return 'Review unreadable';
  }
}
