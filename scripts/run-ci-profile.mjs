#!/usr/bin/env node
// run-ci-profile.mjs — SKILL.md step 6.2's local-CI re-run, taken under
// claude-orchestrator's machine-wide lease so the main session's suite does not
// run unleased beside engine sessions. Resolves the repo's commands through
// lib/ci-profile.mjs (the registry entry in references/repo-ci-profiles.json,
// else the repo's own `scripts/ci` on its base branch, exactly as step 4 did)
// and runs them as one `cli-lease.js --shell`
// line, each command in its own subshell (a `cd <subdir>` must not leak into
// the next command, and an `|| { …; }` tail must not mask an earlier failure),
// first failure short-circuiting, from the worktree. Exit codes: 75 = no lease
// slot (rerun); 64 = setup error (missing worktree, missing lease CLI, no CI
// profile, a failed scripts/ci lookup, bad usage, spawn failure: never a test
// failure); 128 + n = the lease CLI was killed by signal n; anything else is
// the suite's own status.
//
// Usage: node run-ci-profile.mjs --repo <owner/repo> --worktree <path>

import { existsSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ciProfileFor, inWorktree } from './lib/ci-profile.mjs';
import { stringOption } from './lib/cli-args.mjs';
import { coDistPathIn, coHome as locateCoHome } from './lib/co-home.mjs';
import { isMain } from './lib/is-main.mjs';
import { REPO_RE } from './lib/ref.mjs';

/** One `/bin/sh` line running each command in its own subshell, short-circuiting on the first failure. Newlines inside the parens keep a trailing comment from eating the `)`. */
export function composeCiLine(commands) {
  return commands.map((c) => `(\n${c}\n)`).join(' && ');
}

/**
 * A resolved profile's commands (lib/ci-profile.mjs's `{ repo, commands }`); throws `no CI profile for <repo>` when
 * it has none. failure.mjs's `ciStatusAfterProfile` callers and SKILL.md step 5 match that text, so it must not change.
 */
export function commandsFor({ repo, commands }) {
  if (!Array.isArray(commands) || commands.length === 0) throw new Error(`no CI profile for ${repo}`);
  return commands;
}

/** argv for `node`: the lease CLI with the composed line as a single `--shell` argument (no shell quoting needed). The label names the run without leaking credentials. */
export function cliArgs({ repo, line, coHome, maxWait }) {
  return [coDistPathIn(coHome, 'cli-lease.js'), '--max-wait', String(maxWait), '--label', `run-ci-profile ${repo}`, '--shell', line];
}

/** Runs a resolved profile under the lease from `worktree`; returns the spawnSync result. */
export function runCiProfile({ profile, worktree, env = process.env, maxWait = 100, stdio = 'inherit' }) {
  const args = cliArgs({ repo: profile.repo, line: composeCiLine(commandsFor(profile)), coHome: locateCoHome(env), maxWait });
  return spawnSync(process.execPath, args, { cwd: worktree, env, stdio });
}

/** One stderr line naming why a spawn produced no exit status (spawn error such as ENOENT, or a signal); null when it exited normally. */
export function spawnFailure(result) {
  if (result.error) return `could not start the lease CLI: ${result.error.message}${result.error.code ? ` (${result.error.code})` : ''}`;
  if (result.status === null && result.signal) return `lease CLI killed by ${result.signal}`;
  return null;
}

const EX_USAGE = 64;

/** The exit status for a spawn result: the child's own status, 128 + signal number when killed, 64 when it never started. */
export function exitCodeFor(result) {
  if (typeof result.status === 'number') return result.status;
  if (result.signal) return 128 + (osConstants.signals[result.signal] ?? 0);
  return EX_USAGE;
}

/** One line naming the first local setup problem (missing worktree, missing lease CLI), or null. Checked before the profile lookup, which may ask GitHub. */
export function setupProblem({ worktree, coHome = locateCoHome() }) {
  if (!existsSync(worktree)) return `worktree ${worktree} does not exist`;
  const cliPath = coDistPathIn(coHome, 'cli-lease.js');
  if (!existsSync(cliPath)) return `${cliPath} not found: build or point CO_HOME at a claude-orchestrator checkout`;
  return null;
}

async function main(argv) {
  let repo;
  let worktree;
  try {
    repo = stringOption(argv, '--repo');
    worktree = stringOption(argv, '--worktree');
  } catch (err) {
    process.stderr.write(`run-ci-profile: ${err.message}\n`);
    process.exit(EX_USAGE);
  }
  if (!repo || !worktree || !REPO_RE.test(repo)) {
    process.stderr.write('usage: run-ci-profile.mjs --repo <owner/repo> --worktree <path>\n');
    process.exit(EX_USAGE);
  }
  const problem = setupProblem({ worktree });
  if (problem) {
    process.stderr.write(`run-ci-profile: ${problem}\n`);
    process.exit(EX_USAGE);
  }
  let profile;
  try {
    profile = inWorktree(await ciProfileFor(repo), worktree);
    commandsFor(profile);
  } catch (err) {
    process.stderr.write(`run-ci-profile: ${err.message}\n`);
    process.exit(EX_USAGE);
  }
  try {
    const result = runCiProfile({ profile, worktree });
    const failure = spawnFailure(result);
    if (failure) process.stderr.write(`run-ci-profile: ${failure}\n`);
    process.exit(exitCodeFor(result));
  } catch (err) {
    process.stderr.write(`run-ci-profile: ${err.message}\n`);
    process.exit(EX_USAGE);
  }
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
