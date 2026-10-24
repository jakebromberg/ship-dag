#!/usr/bin/env node
// host-sync-claude.mjs <host> [--dry-run] — sync this machine's Claude config (CLAUDE.md, lease hook entries in
// settings.json, skills/) to a host from the host registry (scripts/lib/hosts.mjs). Exits 0 when the sync finished (with --dry-run, when
// nothing is pending), 1 if a step failed, 2 on usage (the registry is read after the arguments pass), 3 when every failure was a dropped connection before anything on
// the host changed, and 10 when --dry-run found changes pending.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadHosts } from './lib/hosts.mjs';
import { syncClaude } from './lib/host-sync-claude.mjs';
import { EXIT, UsageError, runCli } from './lib/remote.mjs';
import { isMain } from './lib/is-main.mjs';

/** The real `run`: every command is bounded, so a hung host fails its step (rsync of skills/ gets longer). */
export const runner = (spawn = spawnSync) => (cmd, args, input) =>
  spawn(cmd, args, { encoding: 'utf8', input, timeout: cmd === 'rsync' ? 600_000 : 120_000 });

/** Sync the one host named in `argv`; returns the exit code, or throws a `UsageError` for a bad command line. The registry (`hosts`, else `loadHosts()`) is read only after the arguments pass. */
export function main(argv, { hosts, loadHosts: load = loadHosts, ...deps } = {}) {
  // Exactly one host plus --dry-run: any other argument (`-n`, `dry-run`, `—dry-run`, `--dryrun`) is refused, never
  // ignored, so a mistyped dry run cannot become a real sync.
  const args = argv.filter((a) => a !== '--dry-run');
  const usage = (why) => new UsageError(`usage: host-sync-claude.mjs <host> [--dry-run]; ${why}`);
  if (args.length !== 1) throw usage(`expected one host, got: ${args.join(' ') || 'none'}`);
  const registry = hosts ?? load();
  if (!Object.hasOwn(registry, args[0])) throw usage(`unknown host: ${args[0]}`);
  const host = registry[args[0]];
  const dryRun = argv.includes('--dry-run');
  const { changes, failures, unreachable } = syncClaude({
    host, run: runner(), readFile: (p) => readFileSync(p, 'utf8'), localHome: `${homedir()}/.claude`,
    dryRun, log: (m) => console.log(m), ...deps,
  });
  if (failures.length) return unreachable ? EXIT.unreachable : EXIT.failure;
  return dryRun && changes.length ? EXIT.pending : EXIT.ok;
}

/** `main` under the shared entry wrapper: the exit code for `argv`, errors written to `deps.err`. */
export const cli = (argv, deps) => runCli(main, argv, deps);

if (isMain(import.meta.url)) process.exitCode = cli(process.argv.slice(2));
