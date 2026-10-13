#!/usr/bin/env node
// rate-limit-preflight.mjs — SKILL.md step 4's cheap utilization preflight,
// run before handing a ready wave to the claude-orchestrator engine.
//
// Every engine run writes its per-issue session transcripts (the
// `--output-format stream-json` log) to `<stateDir>/state/logs/issue-<url-encoded-ref>.log`,
// and step 4 always places `stateDir` under one well-known base
// (`${XDG_STATE_HOME:-$HOME/.local/state}/ship-dag/engine/<runId>`, see
// SKILL.md step 4a). So the preflight has a stable place to look: scan every
// prior run's logs under that base dir, and read the newest `rate_limit_event`
// out of the most recently modified files (still-fresh telemetry, not a stale
// run from days ago). A just-created log can be newest-by-mtime yet carry no
// rate_limit_event at all (the session hasn't gotten far enough to have one
// yet), so the search walks candidates newest-first and keeps going until one
// actually yields a reading, capped at a small number of candidates so the
// preflight stays cheap even when it never finds one. See
// scripts/lib/rate-limit.mjs for the parsing + the wait/hitl decision; this
// file is only the I/O (finding + reading the log) and the CLI wrapper.
//
// No readable source (fresh machine, no prior runs, base dir missing) is not
// an error — the preflight fails open per the issue's decision comment, so
// readLatestUtilization always returns a value rather than throwing.
//
// Usage:
//   node rate-limit-preflight.mjs check [--base-dir DIR] [--threshold 0.8]
//                                        [--wait-max-minutes 30]
// Prints the decision as JSON on stdout (SKILL.md step 4 reads `action`:
// "proceed" | "wait" | "hitl") and a one-line human summary on stderr.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from './lib/is-main.mjs';
import { latestRateLimitEvent, preflightDecision } from './lib/rate-limit.mjs';

/** Default base dir holding every run's engine state (see SKILL.md step 4a). */
export function defaultBaseDir(env = process.env) {
  const stateHome = env.XDG_STATE_HOME || `${env.HOME}/.local/state`;
  return `${stateHome}/ship-dag/engine`;
}

/** How many newest-by-mtime candidates `readLatestUtilization` will read looking for a usable reading, before giving up and reporting none. */
export const DEFAULT_MAX_CANDIDATES = 5;

/**
 * Every `issue-*.log` transcript under any run subdir of `baseDir`
 * (`<baseDir>/<runId>/state/logs/issue-*.log`), newest-by-mtime first, capped
 * to `limit` entries. Empty if the base dir is missing or has no such file.
 * Never throws: an unreadable/non-directory `baseDir`, a run subdir whose
 * `state/logs` vanished or isn't a directory (ENOENT/ENOTDIR/EACCES, e.g. a
 * concurrent run rotating logs), or a file that disappears between the
 * directory listing and the `stat` are all treated as "no candidate here" and
 * skipped rather than thrown.
 * @param {string} baseDir
 * @param {number} [limit]
 * @returns {string[]}
 */
export function newestLogFiles(baseDir, limit = DEFAULT_MAX_CANDIDATES) {
  let runIds;
  try {
    runIds = readdirSync(baseDir);
  } catch {
    return []; // missing baseDir, baseDir is a file (ENOTDIR), permission error, ...
  }
  const candidates = [];
  for (const runId of runIds) {
    const logsDir = join(baseDir, runId, 'state', 'logs');
    let names;
    try {
      names = readdirSync(logsDir);
    } catch {
      continue; // no logs dir for this run, or it vanished/isn't a dir mid-walk
    }
    for (const name of names) {
      // Excludes the engine's issue-<ref>.stderr.log companions (also
      // issue-*-prefixed, also .log-suffixed) — no transcript in those.
      if (!name.startsWith('issue-') || !name.endsWith('.log') || name.endsWith('.stderr.log')) continue;
      const p = join(logsDir, name);
      let mtime;
      try {
        mtime = statSync(p).mtimeMs;
      } catch {
        continue; // a concurrent run may rotate/remove a log between readdir and stat
      }
      candidates.push({ p, mtime });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates.slice(0, limit).map((c) => c.p);
}

/**
 * The single most recently modified `issue-*.log` transcript under `baseDir`,
 * or null if there is none. A thin convenience wrapper over
 * `newestLogFiles`; `readLatestUtilization` uses the full
 * candidate list instead so a newest-but-empty log can't shadow an older one
 * that actually has a reading.
 * @param {string} baseDir
 * @returns {string|null}
 */
export function newestLogFile(baseDir) {
  return newestLogFiles(baseDir, 1)[0] ?? null;
}

/**
 * Read the newest five-hour utilization known from any recent session
 * transcript under `baseDir`. Never throws: a missing base dir, an unreadable
 * file, or a transcript with no rate_limit_event lines all report a null
 * utilization so the caller can fail open.
 *
 * A just-created log can be the newest by mtime yet carry no rate_limit_event
 * yet (the session hasn't gotten far enough to report one), so this walks up
 * to `maxCandidates` newest-first candidates and returns the first one that
 * actually yields a reading, rather than stopping at the single newest file.
 * If none do, `source` reports the newest candidate this could actually read
 * (matching the historical "found a file, no usable data in it" shape), or
 * null if no candidate was even readable.
 * @param {string} baseDir
 * @param {{maxCandidates?: number}} [opts]
 * @returns {{utilization: number|null, resetsAt: string|null, source: string|null}}
 */
export function readLatestUtilization(baseDir, { maxCandidates = DEFAULT_MAX_CANDIDATES } = {}) {
  const files = newestLogFiles(baseDir, maxCandidates);
  let fallbackSource = null;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // rotated/removed between listing and read — try the next-newest candidate
    }
    if (fallbackSource === null) fallbackSource = file;
    const latest = latestRateLimitEvent(text);
    if (latest) {
      return { utilization: latest.utilization ?? null, resetsAt: latest.resetsAt ?? null, source: file };
    }
  }
  return { utilization: null, resetsAt: null, source: fallbackSource };
}

/**
 * Parse a `--<flag> <value>` numeric option, rejecting anything `Number()`
 * can't turn into a finite value and anything outside `[min, max]` (either
 * bound optional). A bare `Number()` coercion silently turns garbage input
 * into `NaN`, which compares false against everything downstream — an
 * `--threshold` typo like `abc` would otherwise make preflightDecision's
 * `utilization < threshold` check always false and invert a healthy window
 * into a `hitl` fork instead of erroring loudly. Guards the *other* silent
 * `Number()` trap too: `Number("")` and `Number("  ")` are `0`, not `NaN` —
 * a missing/blank value would otherwise sail through the finite check and
 * land squarely inside `--threshold`'s valid `[0, 1]` range.
 * @param {string} flag  flag name for the error message, without the leading `--`
 * @param {string|undefined} raw
 * @param {{min?: number, max?: number, exclusiveMin?: number}} [bounds]
 * @returns {number}
 */
export function parseNumberOption(flag, raw, { min, max, exclusiveMin } = {}) {
  if (raw === undefined || raw.trim() === '') throw new Error(`--${flag} requires a value`);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${flag} must be a number, got: ${JSON.stringify(raw)}`);
  if (min !== undefined && n < min) throw new Error(`--${flag} must be >= ${min}, got: ${n}`);
  if (max !== undefined && n > max) throw new Error(`--${flag} must be <= ${max}, got: ${n}`);
  if (exclusiveMin !== undefined && n <= exclusiveMin) throw new Error(`--${flag} must be a positive number, got: ${n}`);
  return n;
}

/**
 * Parse the `check` subcommand's flags. Throws (with a message naming the bad
 * flag and value) on a non-numeric or out-of-range `--threshold` /
 * `--wait-max-minutes` rather than propagating a silent `NaN` — see
 * `parseNumberOption`. Exported for direct unit coverage; `main` is the
 * only caller in normal operation.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = { baseDir: undefined, threshold: 0.8, waitMaxMinutes: 30 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base-dir') opts.baseDir = argv[++i];
    else if (a === '--threshold') opts.threshold = parseNumberOption('threshold', argv[++i], { min: 0, max: 1 });
    else if (a === '--wait-max-minutes') {
      // "a positive number" (not merely non-negative) — 0 would make every
      // above-threshold reading resolve to `hitl` (there being no wait window
      // to bother sleeping through), which is what --wait-max-minutes exists
      // to opt out of by omission, not by being handed a zero.
      opts.waitMaxMinutes = parseNumberOption('wait-max-minutes', argv[++i], { exclusiveMin: 0 });
    }
  }
  return opts;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'check') {
    process.stderr.write('usage: rate-limit-preflight.mjs check [--base-dir DIR] [--threshold 0.8] [--wait-max-minutes 30]\n');
    process.exit(2);
  }
  let opts;
  try {
    opts = parseArgs(rest);
  } catch (err) {
    // A malformed flag is a caller bug (a typo'd invocation), not an absent-data
    // situation — this is the one place the preflight deliberately does NOT fail
    // open, since silently swapping in a default would mask exactly the kind of
    // input that made --threshold abc invert a healthy window into a HITL fork.
    process.stderr.write(`rate-limit-preflight: ${err.message}\n`);
    process.exit(2);
  }
  const baseDir = opts.baseDir || defaultBaseDir();
  const { utilization, resetsAt, source } = readLatestUtilization(baseDir);
  const decision = preflightDecision({ utilization, resetsAt, threshold: opts.threshold, waitMaxMinutes: opts.waitMaxMinutes });
  const out = { ...decision, source };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (decision.reason === 'no-utilization-data') {
    process.stderr.write(`rate-limit-preflight: no recent session transcript under ${baseDir} — proceeding (fail-open)\n`);
  } else if (decision.action === 'wait') {
    process.stderr.write(`rate-limit-preflight: five-hour window at ${(utilization * 100).toFixed(0)}%, resets ${resetsAt} — waiting\n`);
  } else if (decision.action === 'hitl') {
    process.stderr.write(`rate-limit-preflight: five-hour window at ${(utilization * 100).toFixed(0)}% — HITL fork (wait / defer / stop)\n`);
  } else {
    process.stderr.write(`rate-limit-preflight: five-hour window at ${(utilization * 100).toFixed(0)}% — proceeding\n`);
  }
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
