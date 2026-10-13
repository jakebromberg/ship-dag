#!/usr/bin/env node
// diagnose-failure.mjs — SKILL.md step 5's one-read answer to "why did this
// issue's engine session fail, and where does it route?"
//
// This exists because of run sd-20260831-162148. The engine reported
// `status: "failed"` for daisysguide/backend#620 with no reason attached.
// Establishing why took six tool calls and came within one harness truncation
// of ingesting a 1.1MB session transcript via a naive `tail` — roughly 30k of
// main-session context spent rediscovering something that was already sitting
// in the last line of that file, and which `classifyFailureReason` (see
// lib/rate-limit.mjs) could have answered in one call.
//
// The reason the agent improvised rather than calling that helper: step 5's
// only branch routing to it was written for a `failed` row with NO PR, and
// this row had `prNumber: 625`. `failed`-with-a-PR matched nothing, so there
// was nothing to follow. That gap is now closed in two places — `routeFailure`
// in lib/failure.mjs decides it, and this CLI makes the whole diagnosis one
// cheap invocation whose output is a few hundred bytes.
//
// Two producers, one shape. The engine writes a diagnosis for every
// non-succeeded row as it finishes (scripts/engine/failure-digest.mjs), which
// is the cheap and authoritative path — it ran while the transcript was hot.
// This script prefers that file and falls back to computing the same object
// from the report and transcript, which is what makes it work on a run the
// engine digested before this existed, or one it never digested at all.
//
// **Never `cat`/`tail`/`grep` `state/logs/issue-*.log` yourself.** Those are
// full `--output-format stream-json` session transcripts, routinely megabytes,
// and reading one into an agent context costs more than the wave it describes.
// This script is the supported way to ask what one says.
//
// Usage:
//   node diagnose-failure.mjs <owner/repo#N> --state-dir <dir>
//   node diagnose-failure.mjs <owner/repo#N> --run-id <runId>   # under the default base dir
// Prints the diagnosis as JSON on stdout and a one-line summary on stderr.
// Exit 2 on a malformed invocation, 3 when the state dir has no such row.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isMain } from './lib/is-main.mjs';
import { artifactStem, createTranscriptScan, buildDiagnosis, MAX_REASON_CHARS } from './lib/failure.mjs';
import { defaultBaseDir } from './rate-limit-preflight.mjs';

export { MAX_REASON_CHARS };

/**
 * The engine's transcript path for a composite ref — `owner/repo#N` becomes
 * `issue-owner%2Frepo%23N.log`, per `artifactStem`.
 * @param {string} stateDir
 * @param {string} ref
 */
export function logPathForRef(stateDir, ref) {
  return join(stateDir, 'state', 'logs', `issue-${artifactStem(ref)}.log`);
}

/**
 * Where the engine's post-run pass writes this ref's diagnosis, if it ran.
 * @param {string} stateDir
 * @param {string} ref
 */
export function digestPathForRef(stateDir, ref) {
  return join(stateDir, 'state', 'failure-digest', `issue-${artifactStem(ref)}.json`);
}

/**
 * The newest-by-mtime `state/reports/*.json`, or null when there is none.
 * The engine writes a `.md` companion beside each report; only the JSON is
 * machine-readable, so the `.md` is filtered out rather than sorted against.
 * @param {string} stateDir
 * @returns {string|null}
 */
export function newestReportFile(stateDir) {
  const dir = join(stateDir, 'state', 'reports');
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const candidates = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const p = join(dir, name);
    try {
      candidates.push({ p, mtime: statSync(p).mtimeMs });
    } catch {
      continue; // vanished between listing and stat
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.p ?? null;
}

/**
 * Diagnose one issue's engine session from its run state dir. Reads the newest
 * report for the row and, if present, the session transcript for its terminal
 * record and rate-limit signature — but returns only the handful of fields
 * step 5 acts on, never the transcript itself.
 *
 * Throws (rather than returning a partial guess) when the state dir carries no
 * report, or no row for `ref`: both mean the caller is pointed at the wrong run,
 * and silently routing that to `point-B` would send a human to grill about an
 * issue the engine never touched. The unknown-ref message names the refs that
 * ARE present, which is usually enough to spot the wrong runId immediately.
 *
 * @param {string} stateDir  the run's engine state dir (`.../ship-dag/engine/<runId>`)
 * @param {string} ref       composite issue ref, `owner/repo#N`
 */
export function diagnose(stateDir, ref) {
  // The engine already answered this if it digested the run — prefer that over
  // re-reading a transcript that may be megabytes.
  // Only a digest of the newest report (or an unstamped, legacy one) is read: an earlier wave's would route the row by its old stop.
  const digestFile = digestPathForRef(stateDir, ref);
  if (existsSync(digestFile)) {
    try {
      const digest = JSON.parse(readFileSync(digestFile, 'utf8'));
      const newest = newestReportFile(stateDir);
      if (!digest.reportId || (newest && digest.reportId === basename(newest, '.json'))) return { ...digest, source: 'digest', digest: digestFile };
    } catch {
      // A torn or truncated digest is not worth failing over — recompute below.
    }
  }

  const reportFile = newestReportFile(stateDir);
  if (!reportFile) throw new Error(`no engine report under ${join(stateDir, 'state', 'reports')} — is this the right run's state dir?`);
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  const rows = Array.isArray(report.issues) ? report.issues : [];
  const row = rows.find((r) => r.ref === ref);
  if (!row) {
    const known = rows.map((r) => r.ref).join(', ') || '(none)';
    throw new Error(`no row for ${ref} in ${reportFile}; that report covers: ${known}`);
  }

  const transcriptPath = logPathForRef(stateDir, ref);
  let transcript = null;
  try {
    transcript = readFileSync(transcriptPath, 'utf8');
  } catch {
    transcript = null; // a session that died before its first write leaves no log
  }

  const scan = createTranscriptScan();
  if (transcript !== null) for (const line of transcript.split('\n')) scan.line(line);
  const { terminal, rateLimited } = scan.result();

  return {
    ...buildDiagnosis({ row, terminal, rateLimited }),
    source: 'report',
    transcript: transcript === null ? null : transcriptPath,
    report: reportFile,
  };
}

/** Parse `<ref> [--state-dir DIR] [--run-id ID]`. Throws on a missing ref or a state dir that can't be resolved. */
export function parseArgs(argv, env = process.env) {
  let ref = null;
  let stateDir;
  let runId;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--state-dir') stateDir = argv[++i];
    else if (a === '--run-id') runId = argv[++i];
    else if (!a.startsWith('--') && ref === null) ref = a;
  }
  if (!ref) throw new Error('an issue ref (owner/repo#N) is required');
  if (!stateDir && !runId) throw new Error('one of --state-dir or --run-id is required');
  return { ref, stateDir: stateDir || join(defaultBaseDir(env), runId) };
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`diagnose-failure: ${err.message}\nusage: diagnose-failure.mjs <owner/repo#N> --state-dir <dir> | --run-id <runId>\n`);
    process.exit(2);
  }
  let out;
  try {
    out = diagnose(opts.stateDir, opts.ref);
  } catch (err) {
    process.stderr.write(`diagnose-failure: ${err.message}\n`);
    process.exit(3);
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  const pr = out.prNumber ? `PR #${out.prNumber}` : 'no PR';
  process.stderr.write(`diagnose-failure: ${out.ref} ${out.status} (${pr}${out.failureReason ? `, ${out.failureReason}` : ''}) → ${out.route}\n`);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
