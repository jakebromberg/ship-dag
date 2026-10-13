#!/usr/bin/env node
// run-ci-profile.mjs — SKILL.md step 6.2's local-CI re-run, taken under
// claude-orchestrator's machine-wide lease so the main session's suite does not
// run unleased beside engine sessions. Reads the repo's `commands` from
// references/repo-ci-profiles.json and runs them as one `cli-lease.js --shell`
// line, each command in its own subshell (a `cd <subdir>` must not leak into
// the next command, and an `|| { …; }` tail must not mask an earlier failure),
// first failure short-circuiting, from the worktree. Exit codes pass through;
// 75 means no lease slot: rerun.
//
// Usage: node run-ci-profile.mjs --repo <owner/repo> --worktree <path>

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';

const PROFILES = join(dirname(fileURLToPath(import.meta.url)), '..', 'references', 'repo-ci-profiles.json');
const DEFAULT_CO_HOME = '/Users/me/Developer/claude-orchestrator';

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
  return [join(coHome, 'dist', 'src', 'cli-lease.js'), '--max-wait', String(maxWait), '--label', `run-ci-profile ${repo}`, '--shell', line];
}

/** Runs the repo's profile under the lease from `worktree`; returns the spawnSync result. */
export function runCiProfile({ repo, worktree, profilesPath = PROFILES, env = process.env, maxWait = 100, stdio = 'inherit' }) {
  const commands = commandsFor(repo, JSON.parse(readFileSync(profilesPath, 'utf8')).profiles);
  const args = cliArgs({ repo, line: composeCiLine(commands), coHome: env.CO_HOME || DEFAULT_CO_HOME, maxWait });
  return spawnSync(process.execPath, args, { cwd: worktree, env, stdio });
}

function main(argv) {
  const opt = (name) => argv[argv.indexOf(name) + 1];
  const repo = argv.includes('--repo') && opt('--repo');
  const worktree = argv.includes('--worktree') && opt('--worktree');
  if (!repo || !worktree) {
    process.stderr.write('usage: run-ci-profile.mjs --repo <owner/repo> --worktree <path>\n');
    process.exit(2);
  }
  try {
    process.exit(runCiProfile({ repo, worktree }).status ?? 1);
  } catch (err) {
    process.stderr.write(`run-ci-profile: ${err.message}\n`);
    process.exit(2);
  }
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
