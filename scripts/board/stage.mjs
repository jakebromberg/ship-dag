// stage.mjs — a ticket's stage, read from the files the engine and the review
// gate already write, so the board never shows a hand-written stage that the
// engine has since contradicted.
//
// Nothing here is new bookkeeping: the engine's status and metadata files, its
// per-run records, and the review files step 4d writes. Paths come from the
// same helpers diagnose-failure.mjs uses, and a review is scored by the gate's
// own `gateReview`, so the board and the merge gate cannot disagree about what
// blocks.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { statusPathForRef, metadataPathForRef } from '../diagnose-failure.mjs';
import { artifactStem, routeFailure } from '../lib/failure.mjs';
import { gateReview } from '../review-gate.mjs';

const readText = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

/**
 * Derive a ticket's stage, or null when the files say nothing about it. First
 * match wins:
 *  - `running`: **Building**, unless a run that started at or after the wave
 *    launched lists this ref — the engine writes a run record only when a run
 *    finishes, so that means the session died and the ticket is **Stalled**.
 *  - `failed`/`interrupted` with no PR (`routeFailure`): **Stalled**.
 *  - no open PR: null.
 *  - an open PR and no review file: **In review**.
 *  - the newest review file, scored with `gateReview` under the run's
 *    `--block-on`: blocking → **Fixing**; otherwise **Reviewed** (never "ready
 *    to merge": the board can't run the gate's arrival check); an empty
 *    findings array beside a `.raw` sibling, or anything unreadable →
 *    **Review unreadable**.
 *
 * @param {object} a
 * @param {string} a.dir  the run dir holding this ticket's latest wave (its `state/`)
 * @param {string} a.ref  composite ref
 * @param {number} a.waveTs  when that wave launched (ms since epoch)
 * @param {string[]} a.reviewDirs  every `reviews/` dir in the run family
 * @param {string[]} a.blockOn  the run's parsed `--block-on`
 * @param {boolean} a.prOpen  whether the ticket has an open PR
 * @returns {'Building'|'Stalled'|'In review'|'Fixing'|'Reviewed'|'Review unreadable'|null}
 */
export function deriveStage({ dir, ref, waveTs, reviewDirs, blockOn, prOpen }) {
  const status = (readText(statusPathForRef(dir, ref)) || 'pending').trim();
  const metadata = readJson(metadataPathForRef(dir, ref)) || {};
  if (status === 'running') return diedAfter(dir, ref, waveTs) ? 'Stalled' : 'Building';
  if ((status === 'failed' || status === 'interrupted') && routeFailure({ status, prNumber: metadata.prNumber }) !== 'review-gate') {
    return 'Stalled';
  }
  if (!prOpen) return null;
  const review = newestReview(reviewDirs, ref);
  if (!review) return 'In review';
  return scoreReview(review, blockOn);
}

/** Whether a finished run that started at or after `waveTs` lists `ref`. */
function diedAfter(dir, ref, waveTs) {
  const runs = join(dir, 'state', 'runs');
  let names;
  try { names = readdirSync(runs); } catch { return false; }
  return names.filter((n) => n.endsWith('.json')).some((n) => {
    const run = readJson(join(runs, n));
    return run && Date.parse(run.startedAt) >= waveTs && Object.hasOwn(run.statuses || {}, ref);
  });
}

/**
 * The newest review file for `ref` across `reviewDirs`, by mtime. Only the
 * bare stem or the stem plus one tag counts (`<stem>.json`, `<stem>.r2.json`, and
 * the legacy `<stem>-r2.json`),
 * read non-recursively, so another issue's file (`#123` for `#12`), a `.raw`
 * salvage, or a per-pass file under `passes/` is never scored.
 */
function newestReview(reviewDirs, ref) {
  const stem = artifactStem(ref).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const name = new RegExp(`^${stem}([.-][A-Za-z0-9]+)?\\.json$`);
  let best = null;
  for (const d of reviewDirs) {
    let names;
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!name.test(n)) continue;
      const path = join(d, n);
      const st = statSync(path);
      if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { path, mtimeMs: st.mtimeMs };
    }
  }
  return best?.path ?? null;
}

function scoreReview(path, blockOn) {
  const review = readJson(path);
  if (!review) return 'Review unreadable';
  if (Array.isArray(review.findings) && review.findings.length === 0 && existsSync(`${path}.raw`)) return 'Review unreadable';
  try {
    return gateReview(review, blockOn).verdict === 'blocking' ? 'Fixing' : 'Reviewed';
  } catch {
    return 'Review unreadable';
  }
}
