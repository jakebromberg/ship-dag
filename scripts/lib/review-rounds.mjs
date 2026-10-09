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

/**
 * Every review round file for `ref` across `dirs`, oldest first by mtime.
 * A dir that can't be read is skipped.
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
      if (st.isFile()) out.push({ path, mtimeMs: st.mtimeMs });
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
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
