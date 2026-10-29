#!/usr/bin/env node
// ci-profile.mjs — SKILL.md step 4's per-repo CI lookup. Prints the wave's `repos` map for the emit-config spec,
// `{ "<owner/repo>": { baseBranch, commands, source } }`, resolved by lib/ci-profile.mjs: the registry entry's
// commands, else the repo's own executable `scripts/ci` on its base branch (the entry's, else the repo's default
// branch), else none (`source: "none"`, `commands: []`, which emit-config warns about). Exit codes: 0 = printed;
// 1 = a lookup failed (stderr names the repo; nothing on stdout, so a partial map never reaches a spec); 64 = usage.
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

async function main(argv) {
  if (argv[0] === '--local-lint-rule' && argv.length === 2 && REPO_RE.test(argv[1])) {
    // The fallbacks' digest suffix: the registry's rule for the repo, or nothing for a repo that declares none.
    const localLint = loadProfiles(process.env.SHIP_DAG_CI_PROFILES || undefined)[argv[1]]?.localLint;
    const problem = localLintProblem(localLint);
    if (problem) {
      process.stderr.write(`ci-profile: localLint on ${argv[1]} ${problem}\n`);
      process.exit(2);
    }
    const rule = localLintRule(localLint);
    if (rule) process.stdout.write(`${rule}\n`);
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
