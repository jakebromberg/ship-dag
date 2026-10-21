#!/usr/bin/env node
// host-sync-claude.mjs <host> [--dry-run] — sync this machine's Claude config (CLAUDE.md, lease hook entries in
// settings.json, skills/) to a host from references/hosts.json. Exits non-zero if a step failed.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadHosts } from './lib/hosts.mjs';
import { syncClaude } from './lib/host-sync-claude.mjs';
import { isMain } from './lib/is-main.mjs';

/** The real `run`: every command is bounded, so a hung host fails its step (rsync of skills/ gets longer). */
export const runner = (spawn = spawnSync) => (cmd, args, input) =>
  spawn(cmd, args, { encoding: 'utf8', input, timeout: cmd === 'rsync' ? 600_000 : 120_000 });

export function main(argv, { hosts = loadHosts(), ...deps } = {}) {
  // Exactly one host plus --dry-run: any other argument (`-n`, `dry-run`, `—dry-run`, `--dryrun`) is refused, never
  // ignored, so a mistyped dry run cannot become a real sync.
  const args = argv.filter((a) => a !== '--dry-run');
  const host = args.length === 1 && Object.hasOwn(hosts, args[0]) ? hosts[args[0]] : undefined;
  if (!host) {
    console.error(`usage: host-sync-claude.mjs <host> [--dry-run]; ${args.length === 1 ? `unknown host: ${args[0]}` : `expected one host, got: ${args.join(' ') || 'none'}`}`);
    return 2;
  }
  const { failures } = syncClaude({
    host, run: runner(), readFile: (p) => readFileSync(p, 'utf8'), localHome: `${homedir()}/.claude`,
    dryRun: argv.includes('--dry-run'), log: (m) => console.log(m), ...deps,
  });
  return failures.length ? 1 : 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
