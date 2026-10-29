#!/usr/bin/env node
// ci-profile.mjs — SKILL.md step 4's per-repo CI lookup. Prints the wave's `repos` map for the emit-config spec,
// `{ "<owner/repo>": { baseBranch, commands, source } }`, resolved by lib/ci-profile.mjs: the registry entry's
// commands, else the repo's own executable `scripts/ci` on its base branch (the entry's, else the repo's default
// branch), else none (`source: "none"`, `commands: []`, which emit-config warns about). Exit codes: 0 = printed;
// 1 = a lookup failed (stderr names the repo; nothing on stdout, so a partial map never reaches a spec); 64 = usage.
// `--local-lint-rule` exits 0 (rule printed, or nothing for an undeclared repo) or 2 (the repo's registry `localLint` is malformed: stderr names the repo, nothing on stdout).
//
// Usage: node ci-profile.mjs <owner/repo>...
//        node ci-profile.mjs --local-lint-rule <owner/repo>   (the repo's "Local lint (binding)" rule, to append to a digest on the fallback paths; empty when undeclared)

import { ciProfileFor, loadProfiles, localLintProblem, localLintRule } from './lib/ci-profile.mjs';
import { isMain } from './lib/is-main.mjs';
import { REPO_RE } from './lib/ref.mjs';

const EX_USAGE = 64;

/** The `repos` map for `repos`, each entry `{ baseBranch, commands, source }`, looked up in parallel over one read of the registry. */
export async function reposMap(repos, { profiles = loadProfiles(), ...opts } = {}) {
  const resolved = await Promise.all(repos.map((repo) => ciProfileFor(repo, { profiles, ...opts })));
  return Object.fromEntries(resolved.map(({ repo, ...profile }) => [repo, profile]));
}

/**
 * `--local-lint-rule <repo>`: prints the registry's "Local lint (binding)" rule for `repo` (nothing when it declares
 * none) and returns 0, or reports a malformed `localLint` on `err`, prints nothing and returns 2. `profiles` is
 * injectable, as in host-run.mjs.
 */
export function localLintRuleCli(repo, { profiles = loadProfiles(), out = (t) => process.stdout.write(t), err = (t) => process.stderr.write(t) } = {}) {
  const localLint = profiles[repo]?.localLint;
  const problem = localLintProblem(localLint);
  if (problem) {
    err(`ci-profile: localLint on ${repo} ${problem}\n`);
    return 2;
  }
  const rule = localLintRule(localLint);
  if (rule) out(`${rule}\n`);
  return 0;
}

async function main(argv) {
  if (argv[0] === '--local-lint-rule' && argv.length === 2 && REPO_RE.test(argv[1])) {
    const code = localLintRuleCli(argv[1]);
    if (code !== 0) process.exit(code);
    return;
  }
  if (argv.length === 0 || !argv.every((a) => REPO_RE.test(a))) {
    process.stderr.write('usage: ci-profile.mjs <owner/repo>... | --local-lint-rule <owner/repo>\n');
    process.exit(EX_USAGE);
  }
  try {
    process.stdout.write(`${JSON.stringify(await reposMap(argv), null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`ci-profile: ${err.message}\n`);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
