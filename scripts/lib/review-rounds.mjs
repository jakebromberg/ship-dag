// review-rounds.mjs — the one place that decides which files are a ref's review
// rounds, so the board, wave ingestion and the review instrumentation can never
// disagree about it.
//
// A round is `<stem>.json`, or the stem plus one tag led by `.` or `-`
// (`.r2`, `-r3`, `.iter1`, `.pass3-skills`), where `<stem>` is `artifactStem(ref)`.
// The separator after the stem is what keeps `#1` from matching `#12`'s files.
// Only the dir itself is read: `.raw` salvage files and per-pass files under
// `passes/` are never rounds.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { artifactStem } from './failure.mjs';
import { gateReview, issueRefFromPath } from '../review-gate.mjs';

/**
 * Every review round file for `ref` across `dirs`, oldest first. When every file has a name SKILL.md
 * gives a round (`<stem>.json` is round 1, `<stem>.r<N>.json` or `-r<N>` is round N), they are ordered
 * by round number, so a copy that does not keep mtimes does not reorder them. A set holding any other
 * (legacy) tag has no round numbers to go by and is ordered by mtime, as is a tie on the number (the
 * same round in two dirs). A dir that can't be read is skipped.
 * @param {string[]} dirs  `reviews/` dirs, typically one per run-family member
 * @param {string} ref  composite ref
 * @returns {Array<{path:string, mtimeMs:number}>}
 */
export function reviewRoundFiles(dirs, ref) {
  const stem = artifactStem(ref).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const round = new RegExp(`^${stem}([.-][A-Za-z0-9-]+)?\\.json$`);
  const out = [];
  for (const d of dirs) {
    let names;
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!round.test(n)) continue;
      const path = join(d, n);
      const st = statSync(path);
      if (st.isFile()) out.push({ path, mtimeMs: st.mtimeMs, tag: round.exec(n)[1] });
    }
  }
  const number = ({ tag }) => (tag === undefined ? 1 : Number(/^[.-]r([0-9]+)$/.exec(tag)?.[1] ?? NaN));
  const numbered = out.every((f) => Number.isInteger(number(f)));
  return out
    .sort((a, b) => (numbered ? number(a) - number(b) : 0) || a.mtimeMs - b.mtimeMs)
    .map(({ path, mtimeMs }) => ({ path, mtimeMs }));
}

/**
 * Whether a parsed review is the WXYC/Backend-Service#2587 signature: an empty
 * `findings` array beside a `.raw` sibling, meaning the findings never reached
 * the file. Such a review must read as unreadable, never as clean.
 * @param {string} path  the review file's path
 * @param {object} review  its parsed contents
 */
export function isUnreadableEmpty(path, review) {
  return Array.isArray(review?.findings) && review.findings.length === 0 && existsSync(`${path}.raw`);
}

/**
 * One review round as the gate reads it, for every reader that has to say whether a round is
 * readable: `unreadable` is why it is not (empty beside its `.raw` per `isUnreadableEmpty`, or
 * `gateReview` refused it), else null. An unreadable round is `blocking` with nothing to list,
 * never clean; a readable one is `gateReview`'s own result.
 * @param {{path: string, review: object|null}} round
 * @param {string[]} blockOn  the run's parsed `--block-on`
 * @returns {{unreadable: string|null, verdict: string, blocking: Array<object>}}
 */
export function classifyRound({ path, review }, blockOn) {
  const unreadable = (why) => ({ unreadable: why, verdict: 'blocking', blocking: [] });
  if (isUnreadableEmpty(path, review)) return unreadable('empty beside .raw');
  try { return { unreadable: null, ...gateReview(review, blockOn, undefined, issueRefFromPath(path)) }; } catch (err) { return unreadable(err.message); }
}
