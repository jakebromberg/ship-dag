#!/usr/bin/env node
// ci-profile.mjs — SKILL.md step 4's per-repo CI lookup. Prints the wave's `repos` map for the emit-config spec,
// `{ "<owner/repo>": { baseBranch, commands, source } }`, resolved by lib/ci-profile.mjs: the registry entry's
// commands, else the repo's own `scripts/ci` on its base branch, else none (`source: "none"`, `commands: []`, which
// emit-config warns about). Exit codes: 0 = printed; 1 = a lookup failed (stderr names the repo; nothing on stdout,
// so a partial map never reaches a spec); 64 = usage.
//
// Usage: node ci-profile.mjs <owner/repo>...

import { ciProfileFor } from './lib/ci-profile.mjs';
import { isMain } from './lib/is-main.mjs';

const EX_USAGE = 64;
const REPO = /^[\w.-]+\/[\w.-]+$/;

/** The `repos` map for `repos`, each entry `{ baseBranch, commands, source }`, looked up in parallel. */
export async function reposMap(repos, opts = {}) {
  const profiles = await Promise.all(repos.map((repo) => ciProfileFor(repo, opts)));
  return Object.fromEntries(profiles.map(({ repo, ...profile }) => [repo, profile]));
}

async function main(argv) {
  if (argv.length === 0 || !argv.every((a) => REPO.test(a))) {
    process.stderr.write('usage: ci-profile.mjs <owner/repo>...\n');
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
