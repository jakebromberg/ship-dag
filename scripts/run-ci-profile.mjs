#!/usr/bin/env node
// run-ci-profile.mjs — SKILL.md step 6.2's local-CI re-run, taken under
// claude-orchestrator's machine-wide lease so the main session's suite does not
// run unleased beside engine sessions. Reads the repo's `commands` from
// references/repo-ci-profiles.json and runs them as one `cli-lease.js --shell`
// line, each command in its own subshell (a `cd <subdir>` must not leak into
// the next command, and an `|| { …; }` tail must not mask an earlier failure),
// first failure short-circuiting, from the worktree. Exit codes: 75 = no lease
// slot (rerun); 64 = setup error (missing worktree, missing lease CLI, no CI
// profile, bad usage, spawn failure: never a test failure); 128 + n = the
// lease CLI was killed by signal n; anything else is the suite's own status.
//
// Usage: node run-ci-profile.mjs --repo <owner/repo> --worktree <path>

import { existsSync, readFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringOption } from './lib/cli-args.mjs';
import { coDistPathIn, coHome as locateCoHome } from './lib/co-home.mjs';
import { isMain } from './lib/is-main.mjs';

const PROFILES = join(dirname(fileURLToPath(import.meta.url)), '..', 'references', 'repo-ci-profiles.json');

/** One `/bin/sh` line running each command in its own subshell, short-circuiting on the first failure. Newlines inside the parens keep a trailing comment from eating the `)`. */
export function composeCiLine(commands) {
  return commands.map((c) => `(\n${c}\n)`).join(' && ');
}

/** The repo's CI commands from a profiles map; throws when it has none. */
export function commandsFor(repo, profiles) {
  const commands = profiles[repo]?.commands;
  if (!Array.isArray(commands) || commands.length === 0) throw new Error(`no CI profile for ${repo}`);
  return commands;
}

/** argv for `node`: the lease CLI with the composed line as a single `--shell` argument (no shell quoting needed). The label names the run without leaking credentials. */
export function cliArgs({ repo, line, coHome, maxWait }) {
  return [coDistPathIn(coHome, 'cli-lease.js'), '--max-wait', String(maxWait), '--label', `run-ci-profile ${repo}`, '--shell', line];
}

/** Runs the repo's profile under the lease from `worktree`; returns the spawnSync result. */
export function runCiProfile({ repo, worktree, profilesPath = PROFILES, env = process.env, maxWait = 100, stdio = 'inherit' }) {
  const commands = commandsFor(repo, JSON.parse(readFileSync(profilesPath, 'utf8')).profiles);
  const args = cliArgs({ repo, line: composeCiLine(commands), coHome: locateCoHome(env), maxWait });
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

/** One line naming the first setup problem (missing worktree, missing lease CLI, repo without a CI profile), or null when the run can start. */
export function setupProblem({ repo, worktree, profilesPath = PROFILES, coHome = locateCoHome() }) {
  if (!existsSync(worktree)) return `worktree ${worktree} does not exist`;
  const cliPath = coDistPathIn(coHome, 'cli-lease.js');
  if (!existsSync(cliPath)) return `${cliPath} not found: build or point CO_HOME at a claude-orchestrator checkout`;
  try {
    commandsFor(repo, JSON.parse(readFileSync(profilesPath, 'utf8')).profiles);
  } catch (err) {
    return err.message;
  }
  return null;
}

function main(argv) {
  let repo;
  let worktree;
  try {
    repo = stringOption(argv, '--repo');
    worktree = stringOption(argv, '--worktree');
  } catch (err) {
    process.stderr.write(`run-ci-profile: ${err.message}\n`);
    process.exit(EX_USAGE);
  }
  if (!repo || !worktree) {
    process.stderr.write('usage: run-ci-profile.mjs --repo <owner/repo> --worktree <path>\n');
    process.exit(EX_USAGE);
  }
  const problem = setupProblem({ repo, worktree });
  if (problem) {
    process.stderr.write(`run-ci-profile: ${problem}\n`);
    process.exit(EX_USAGE);
  }
  try {
    const result = runCiProfile({ repo, worktree });
    const failure = spawnFailure(result);
    if (failure) process.stderr.write(`run-ci-profile: ${failure}\n`);
    process.exit(exitCodeFor(result));
  } catch (err) {
    process.stderr.write(`run-ci-profile: ${err.message}\n`);
    process.exit(EX_USAGE);
  }
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
