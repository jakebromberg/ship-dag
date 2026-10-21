#!/usr/bin/env node
// host-prepare.mjs — ready a remote host for a wave: check version parity with this Mac, clone missing repos, fetch
// origin, and place the host's config at <stateDir>/config.json. Never updates ship-dag or the orchestrator, and never
// touches an existing checkout's working tree. Refusals exit 1 naming the fix; a second run changes nothing.
//
// Usage: node host-prepare.mjs <host> <config.<host>.json> [--dry-run] [--min-free-gb N]
//
// Every ssh/scp call is bounded (ConnectTimeout plus an overall timeout), logged as one stderr line, and a failure
// names the host and step.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { reposDirFromEnv } from './engine/repos-dir.mjs';
import { DEFAULT_REPOS_DIR, repoDirName } from './engine/repo-layout.mjs';
import { coHome } from './lib/co-home.mjs';
import { stringOption, parseNumberOption } from './lib/cli-args.mjs';
import { loadHosts } from './lib/hosts.mjs';
import { planHost, probeScript, parseProbe, withCoHome } from './lib/host-prepare.mjs';
import { isMain } from './lib/is-main.mjs';

const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
const sha256 = (path) => { try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return ''; } };
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

const USAGE = 'usage: host-prepare.mjs <host> <config.<host>.json> [--dry-run] [--min-free-gb N]';

/** The bound on a `gh repo clone`, which for a large repo outlasts the default 120 s. */
export const CLONE_TIMEOUT_MS = 30 * 60_000;

/** The real runner: `{ ssh(sshAlias, command, timeoutMs?), scp(sshAlias, from, to) }`, each bounded to `timeoutMs`. */
export const realRunner = (timeoutMs = 120_000) => ({
  ssh: (alias, command, timeout = timeoutMs) => execFileSync('ssh', [...SSH_OPTS, alias, command], { encoding: 'utf8', timeout }),
  scp: (alias, from, to) => execFileSync('scp', [...SSH_OPTS, '-q', from, `${alias}:${to}`], { encoding: 'utf8', timeout: timeoutMs }),
});

/** The org root the engine's hooks resolve repo layout under (hooks.mts): the env override, else layoutWorktreeHooks' default. */
export const layoutReposDir = (env = process.env) => reposDirFromEnv(env) ?? DEFAULT_REPOS_DIR;

/** Probe, plan and (unless `dryRun`) run; returns the process exit code. `run` is the injected runner, `log` writes a stderr line. */
export function prepareHost({ name, hosts, config, configPath, local, run, minFreeGb, dryRun, log, reposDir }) {
  if (!Object.hasOwn(hosts, name)) throw new Error(`unknown host ${JSON.stringify(name)}; known: ${Object.keys(hosts).join(', ') || 'none'}`);
  const host = withCoHome(hosts[name]);
  const call = (step, fn, ...args) => {
    log(`host-prepare: ${name}: ${step}`);
    try { return fn(host.ssh, ...args); } catch (e) { throw new Error(`host-prepare: ${name}: ${step} failed: ${e.message}`); }
  };
  const repos = Object.keys(config.repos ?? {}).map((repo) => ({ repo, name: repo.split('/').pop(), layoutDir: repoDirName(repo, { reposDir }) }));
  const probe = parseProbe(call('probe', run.ssh, probeScript(host, config.stateDir, repos.map((r) => r.name))));
  const { refusals, plan } = planHost({ name, host, stateDir: config.stateDir, projectRoot: config.projectRoot, configPath, repos, local: { ...local, configHash: sha256(configPath) }, probe, minFreeGb });
  for (const r of refusals) log(r);
  if (refusals.length) return 1;
  for (const a of plan) {
    log(`${dryRun ? 'would run' : 'run'}: ${a.step}: ${a.ssh ?? a.scp.join(' -> ')}`);
    if (!dryRun) a.ssh ? call(a.step, run.ssh, a.ssh, a.slow ? CLONE_TIMEOUT_MS : undefined) : call(a.step, run.scp, ...a.scp);
  }
  return 0;
}

function main(argv) {
  const unknown = argv.find((a) => a.startsWith('--') && !['--dry-run', '--min-free-gb'].includes(a));
  if (unknown) throw new Error(`unknown option ${unknown}; ${USAGE}`);
  const [name, configPath] = argv.filter((a, i) => !a.startsWith('--') && !['--min-free-gb'].includes(argv[i - 1]));
  if (!name || !configPath) throw new Error(USAGE);
  const minFreeGb = stringOption(argv, '--min-free-gb') === undefined ? 10 : parseNumberOption('min-free-gb', stringOption(argv, '--min-free-gb'), { min: 0 });
  const sdHome = fileURLToPath(new URL('..', import.meta.url));
  const local = { sdSha: git(sdHome, 'rev-parse', 'HEAD'), coSha: git(coHome(), 'rev-parse', 'HEAD'), claudeHash: sha256(`${homedir()}/.claude/CLAUDE.md`) };
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  return prepareHost({ name, hosts: loadHosts(), config, configPath, local, run: realRunner(), minFreeGb, dryRun: argv.includes('--dry-run'), log: (m) => process.stderr.write(`${m}\n`), reposDir: layoutReposDir() });
}

if (isMain(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 2; }
}
