#!/usr/bin/env node
// rate-limit-preflight.mjs — SKILL.md step 4's cheap utilization preflight,
// run before handing a ready wave to the claude-orchestrator engine.
//
// Every engine run writes its per-issue session transcripts (the
// `--output-format stream-json` log) to `<stateDir>/state/logs/issue-<url-encoded-ref>.log`,
// and step 4 always places `stateDir` under one well-known base
// (`${XDG_STATE_HOME:-$HOME/.local/state}/ship-dag/engine/<runId>`, see
// SKILL.md step 4a). So the preflight has a stable place to look: scan every
// prior run's logs under that base dir, take the most recently modified one
// (still-fresh telemetry, not a stale run from days ago), and read its newest
// `rate_limit_event`. See scripts/lib/rate-limit.mjs for the parsing + the
// wait/hitl decision; this file is only the I/O (finding + reading the log)
// and the CLI wrapper.
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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from './lib/is-main.mjs';
import { latestRateLimitEvent, preflightDecision } from './lib/rate-limit.mjs';

/** Default base dir holding every run's engine state (see SKILL.md step 4a). */
export function defaultBaseDir(env = process.env) {
  const stateHome = env.XDG_STATE_HOME || `${env.HOME}/.local/state`;
  return `${stateHome}/ship-dag/engine`;
}

/**
 * The most recently modified `issue-*.log` transcript under any run subdir of
 * `baseDir` (`<baseDir>/<runId>/state/logs/issue-*.log`), or null if the base
 * dir is missing or has no such file.
 * @param {string} baseDir
 * @returns {string|null}
 */
export function newestLogFile(baseDir) {
  if (!existsSync(baseDir)) return null;
  let newest = null;
  let newestMtime = -Infinity;
  for (const runId of readdirSync(baseDir)) {
    const logsDir = join(baseDir, runId, 'state', 'logs');
    if (!existsSync(logsDir)) continue;
    for (const name of readdirSync(logsDir)) {
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
      if (mtime > newestMtime) {
        newestMtime = mtime;
        newest = p;
      }
    }
  }
  return newest;
}

/**
 * Read the newest five-hour utilization known from any recent session
 * transcript under `baseDir`. Never throws: a missing base dir, an unreadable
 * file, or a transcript with no rate_limit_event lines all report a null
 * utilization so the caller can fail open.
 * @param {string} baseDir
 * @returns {{utilization: number|null, resetsAt: string|null, source: string|null}}
 */
export function readLatestUtilization(baseDir) {
  const file = newestLogFile(baseDir);
  if (!file) return { utilization: null, resetsAt: null, source: null };
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { utilization: null, resetsAt: null, source: null };
  }
  const latest = latestRateLimitEvent(text);
  return {
    utilization: latest?.utilization ?? null,
    resetsAt: latest?.resetsAt ?? null,
    source: file,
  };
}

function parseArgs(argv) {
  const opts = { baseDir: undefined, threshold: 0.8, waitMaxMinutes: 30 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base-dir') opts.baseDir = argv[++i];
    else if (a === '--threshold') opts.threshold = Number(argv[++i]);
    else if (a === '--wait-max-minutes') opts.waitMaxMinutes = Number(argv[++i]);
  }
  return opts;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'check') {
    process.stderr.write('usage: rate-limit-preflight.mjs check [--base-dir DIR] [--threshold 0.8] [--wait-max-minutes 30]\n');
    process.exit(2);
  }
  const opts = parseArgs(rest);
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
