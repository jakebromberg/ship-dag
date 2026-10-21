#!/usr/bin/env node
// host-sync-claude.mjs <host> [--dry-run] — sync this machine's Claude config (CLAUDE.md, lease hook entries in
// settings.json, skills/) to a host from references/hosts.json. Exits 0 when the sync finished (with --dry-run, when
// nothing is pending), 1 if a step failed, 2 on usage, 3 when every failure was a dropped connection before anything on
// the host changed, and 10 when --dry-run found changes pending.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadHosts } from './lib/hosts.mjs';
import { syncClaude } from './lib/host-sync-claude.mjs';
import { EXIT } from './lib/remote.mjs';
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
    return EXIT.usage;
  }
  const dryRun = argv.includes('--dry-run');
  const { changes, failures, unreachable } = syncClaude({
    host, run: runner(), readFile: (p) => readFileSync(p, 'utf8'), localHome: `${homedir()}/.claude`,
    dryRun, log: (m) => console.log(m), ...deps,
  });
  if (failures.length) return unreachable ? EXIT.unreachable : EXIT.failure;
  return dryRun && changes.length ? EXIT.pending : EXIT.ok;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
