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
//   node diagnose-failure.mjs <owner/repo#N> --owner --state-dir <dir>   # only the owning report's id, no transcript read
// Prints the diagnosis as JSON on stdout and a one-line summary on stderr; with --owner, the report id alone on stdout.
// Exit 2 on a malformed invocation, 3 when the state dir has no such row.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMain } from './lib/is-main.mjs';
import { artifactStem, createTranscriptScan, buildDiagnosis, MAX_REASON_CHARS } from './lib/failure.mjs';
import { readRunFamilyReports, reportOwnership } from './lib/wave-reports.mjs';
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
 * The engine's status file for a composite ref (`pending`/`running`/`succeeded`/
 * `failed`/`interrupted`; absent until the engine first touches the issue).
 * @param {string} stateDir
 * @param {string} ref
 */
export function statusPathForRef(stateDir, ref) {
  return join(stateDir, 'state', 'status', `issue-${artifactStem(ref)}.status`);
}

/**
 * The engine's metadata file for a composite ref — `prNumber`/`prUrl` once a PR
 * opens, plus start/finish times and the exit code.
 * @param {string} stateDir
 * @param {string} ref
 */
export function metadataPathForRef(stateDir, ref) {
  return join(stateDir, 'state', 'metadata', `issue-${artifactStem(ref)}.json`);
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
 * The wave report that owns `ref`'s latest event, as `reportOwnership` reads the run family of `stateDir` (the dir and its
 * suffixed retry and resume siblings): the latest report, by parsed `startedAt` (never mtime, which a
 * copied state dir loses and a tie leaves to readdir order), whose row for `ref` is not one it only carries over
 * (`carriedOver` against the reports that started before it, as ingest reads them). A report that cannot be read, or
 * has no parseable `startedAt`, is skipped with a warning (the earliest report that lists `ref` has nothing earlier to
 * carry it over from, so an owner exists whenever one lists it). The engine stamps a digest with the owning report's id, so this is the report that stamp
 * must name; a report that lists other refs, however much newer, does not disown it.
 * @param {string} stateDir
 * @param {string} ref
 * @param {{warn?: (m: string) => void}} [opts]
 * @returns {{id: string, path: string, report: object, startedAt: number, row: object}|null} null when no report lists `ref`
 */
export function owningReport(stateDir, ref, opts) {
  return reportOwnership(readRunFamilyReports(stateDir, opts)).ownerOf(ref);
}

/**
 * Read the run family of `stateDir` and find the report that owns `ref`. The one place that words the two ways that can
 * fail, so `ownerId` and `diagnose` never disagree about a misdirected state dir.
 * @param {string} stateDir
 * @param {string} ref
 * @param {{warn?: (m: string) => void}} [opts]
 * @returns {{owner: ReturnType<typeof owningReport>, require: () => NonNullable<ReturnType<typeof owningReport>>}}
 *   `owner` is null when no report lists `ref`; `require()` returns it, or throws "no engine report" (the family has no
 *   readable report) or "no row for ..." (naming the refs the latest report does carry; a null row in it is skipped)
 */
function findOwner(stateDir, ref, opts) {
  const { reads, ownerOf } = reportOwnership(readRunFamilyReports(stateDir, opts));
  const owner = ownerOf(ref);
  const require = () => {
    if (owner) return owner;
    if (reads.length === 0) throw new Error(`no engine report under ${join(stateDir, 'state', 'reports')} (or any dir of its run family) — is this the right run's state dir?`);
    const latest = reads.at(-1);
    const known = latest.report.issues.flatMap((r) => (r?.ref ? [r.ref] : [])).join(', ') || '(none)';
    throw new Error(`no row for ${ref} in any report of ${stateDir}'s run family; the latest, ${latest.path}, covers: ${known}`);
  };
  return { owner, require };
}

/**
 * The id of the report that owns `ref`'s latest event, for the `{REPORT_ID}` a review round is stamped with. Reads only
 * the reports, never a digest or a transcript. Throws as `diagnose` does when no report lists `ref`.
 * @param {string} stateDir
 * @param {string} ref
 * @param {{warn?: (m: string) => void}} [opts]
 */
export function ownerId(stateDir, ref, opts) {
  return findOwner(stateDir, ref, opts).require().id;
}

/**
 * Diagnose one issue's engine session from its run state dir. Reads the report that
 * owns the row (`owningReport`, from the whole run family) and, from the dir that report is in (the given one or a
 * sibling: the owner's dir, never the given one's by default), its digest or, if present, the session transcript for its terminal
 * record and rate-limit signature — but returns only the handful of fields
 * step 5 acts on, never the transcript itself.
 *
 * Throws (rather than returning a partial guess) when the state dir carries no
 * report, or no row for `ref`: both mean the caller is pointed at the wrong run,
 * and silently routing that to `point-B` would send a human to grill about an
 * issue the engine never touched. The unknown-ref message names the refs that
 * ARE present, which is usually enough to spot the wrong runId immediately.
 *
 * @param {string} stateDir  a dir of the run's family: the run's engine state dir (`.../ship-dag/engine/<runId>`)
 * @param {string} ref       composite issue ref, `owner/repo#N`
 * @param {{warn?: (m: string) => void}} [opts]  where a report that cannot be read is warned about (stderr by default)
 */
export function diagnose(stateDir, ref, opts) {
  const { owner, require } = findOwner(stateDir, ref, opts);

  // The owner's dir is the dir whose state/reports/ holds the owning report; its digest and its transcript are that wave's,
  // so both are read there, never from the dir diagnose was given (a sibling's session is another wave's). Without an owner
  // there is no wave to join to, and the given dir's unstamped digest is all that can answer.
  const ownerDir = owner ? dirname(dirname(dirname(owner.path))) : stateDir;

  // The engine already answered this if it digested the run — prefer that over
  // re-reading a transcript that may be megabytes.
  // Only a digest of the report that owns the row (or an unstamped, legacy one) is read: a digest of an earlier event would route the row by its old stop.
  const digestFile = digestPathForRef(ownerDir, ref);
  if (existsSync(digestFile)) {
    try {
      const digest = JSON.parse(readFileSync(digestFile, 'utf8'));
      if (!digest.reportId || (owner && digest.reportId === owner.id)) return { ...digest, source: 'digest', digest: digestFile };
    } catch {
      // A torn or truncated digest is not worth failing over — recompute below.
    }
  }

  require();
  const { path: reportFile, row } = owner;

  const transcriptPath = logPathForRef(ownerDir, ref);
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

/** Parse `<ref> [--owner] [--state-dir DIR] [--run-id ID]`. Throws on a missing ref or a state dir that can't be resolved. */
export function parseArgs(argv, env = process.env) {
  let ref = null;
  let stateDir;
  let runId;
  let owner = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--state-dir') stateDir = argv[++i];
    else if (a === '--owner') owner = true;
    else if (a === '--run-id') runId = argv[++i];
    else if (!a.startsWith('--') && ref === null) ref = a;
  }
  if (!ref) throw new Error('an issue ref (owner/repo#N) is required');
  if (!stateDir && !runId) throw new Error('one of --state-dir or --run-id is required');
  return { ref, owner, stateDir: stateDir || join(defaultBaseDir(env), runId) };
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`diagnose-failure: ${err.message}\nusage: diagnose-failure.mjs <owner/repo#N> [--owner] --state-dir <dir> | --run-id <runId>\n`);
    process.exit(2);
  }
  let out;
  try {
    if (opts.owner) {
      process.stdout.write(`${ownerId(opts.stateDir, opts.ref)}\n`);
      return;
    }
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
