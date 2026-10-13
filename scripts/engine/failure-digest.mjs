// failure-digest.mjs — the engine's post-run half of /ship-dag's failure diagnosis.
//
// The engine's per-issue session transcripts (`<configDir>/logs/issue-<ref>.log`)
// are full stream-json session logs, not logs in the "read me to debug" sense —
// one dead session was 1.1MB. When a wave finishes with a non-succeeded row the
// answer to "why" is usually in the transcript's own last `result` event, but
// finding it by hand cost six tool calls and nearly ingested the whole file
// (run sd-20260831-162148).
//
// So the engine writes the answer down while the run is still hot: one small
// JSON diagnosis per non-succeeded row, in the SAME shape
// `scripts/diagnose-failure.mjs` produces on demand — including the `route`
// field, which is the part that closes the hole that run actually fell into. A
// `failed` row carrying a PR belongs at the review gate, never in a retry, and
// neither a terminal reason nor an exit code says so on its own.
//
// The transcript is streamed line-by-line and never held in memory whole, and
// the scan comes from `lib/failure.mjs` — the same accumulator the on-demand
// reader folds over a string. One definition, two drivers, so the eager and
// lazy paths cannot drift into disagreeing about the same transcript.
//
// run.mts calls writeFailureDigests() once, after createMain() returns — i.e.
// only on the paths where the engine actually wrote a fresh report.

import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { artifactStem, createTranscriptScan, buildDiagnosis, ranOf } from '../lib/failure.mjs';

/**
 * Stream one transcript, returning the terminal record and whether the session
 * died on a rate limit. Never throws: a missing, unreadable, or torn log
 * reports whatever was found before the failure — a truncated transcript is the
 * normal shape when a session is killed mid-write, and it usually still carries
 * the events that matter.
 * @param {string} logPath
 * @returns {Promise<{terminal: object|null, rateLimited: boolean}>}
 */
export async function scanTranscript(logPath) {
  const scan = createTranscriptScan();
  if (!fs.existsSync(logPath)) return scan.result();
  const stream = fs.createReadStream(logPath, { encoding: 'utf-8' });
  stream.on('error', () => {}); // surfaced as "nothing found", not a crash
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) scan.line(line);
  } catch {
    // fall through with whatever was accumulated before the read failed
  }
  return scan.result();
}

/**
 * The engine's recorded exit code for one issue, or null when no metadata was
 * written. Best-effort: a missing or corrupt metadata file is not worth
 * aborting a digest pass over.
 * @param {string} metaPath
 * @returns {number|null}
 */
export function readExitCode(metaPath) {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    return typeof meta.exitCode === 'number' ? meta.exitCode : null;
  } catch {
    return null;
  }
}

/**
 * Write one diagnosis per non-succeeded row in `report.issues[]` to
 * `<configDir>/failure-digest/issue-<encoded-ref>.json` — the same filename
 * stem the sibling logs/metadata dirs use, so a ref maps to one stem everywhere
 * under configDir.
 *
 * `reportId` (the stem of the report the rows came from) is stamped into each digest, so a reader
 * can assign the digest to its wave without trusting the file's mtime, which a copied state dir loses.
 * A later wave overwrites a ref's digest, so the stamp names the latest wave only, except for a row that
 * launched no session (`ran: false`): it is carried over or failed before launch, so its transcript is
 * unchanged and an existing digest is kept, still stamped with the report that wrote it.
 *
 * Best-effort per row: one row's unreadable transcript or metadata leaves that
 * field null rather than aborting the pass over the others.
 * @param {{configDir: string, report: {issues?: Array<object>}, reportId?: string}} opts
 * @returns {Promise<string[]>} paths written
 */
export async function writeFailureDigests({ configDir, report, reportId }) {
  const rows = (report?.issues ?? []).filter((r) => r.status !== 'succeeded');
  if (rows.length === 0) return [];

  const digestDir = path.join(configDir, 'failure-digest');
  fs.mkdirSync(digestDir, { recursive: true });

  const written = [];
  for (const row of rows) {
    const stem = artifactStem(row.ref);
    const digestPath = path.join(digestDir, `issue-${stem}.json`);
    if (ranOf(row) === false && fs.existsSync(digestPath)) continue;
    const { terminal, rateLimited } = await scanTranscript(path.join(configDir, 'logs', `issue-${stem}.log`));
    const exitCode = readExitCode(path.join(configDir, 'metadata', `issue-${stem}.json`));
    const diagnosis = { ...buildDiagnosis({ row, terminal, rateLimited, exitCode }), ...(reportId && { reportId }) };
    fs.writeFileSync(digestPath, `${JSON.stringify(diagnosis, null, 2)}\n`);
    written.push(digestPath);
  }
  return written;
}
