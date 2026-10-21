#!/usr/bin/env node
// host-sync-claude.mjs <host> [--dry-run] — sync this machine's Claude config (CLAUDE.md, lease hook entries in
// settings.json, skills/) to a host from references/hosts.json. Exits non-zero if a step failed.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadHosts } from './lib/hosts.mjs';
import { syncClaude } from './lib/host-sync-claude.mjs';
import { isMain } from './lib/is-main.mjs';

const run = (cmd, args, input) => spawnSync(cmd, args, { encoding: 'utf8', input });

export function main(argv, { hosts = loadHosts(), ...deps } = {}) {
  const flags = argv.filter((a) => a.startsWith('--') && a !== '--dry-run');
  const name = argv.find((a) => !a.startsWith('--'));
  const host = Object.hasOwn(hosts, String(name)) ? hosts[name] : undefined;
  if (flags.length || !host) {
    console.error(`usage: host-sync-claude.mjs <host> [--dry-run]; ${flags.length ? `unknown flag: ${flags.join(' ')}` : `unknown host: ${name}`}`);
    return 2;
  }
  const { failures } = syncClaude({
    host, run, readFile: (p) => readFileSync(p, 'utf8'), localHome: `${homedir()}/.claude`,
    dryRun: argv.includes('--dry-run'), log: (m) => console.log(m), ...deps,
  });
  return failures.length ? 1 : 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
