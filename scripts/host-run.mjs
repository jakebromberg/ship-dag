#!/usr/bin/env node
// host-run.mjs — run a wave's engine on a remote host and collect its reports and logs into the local stateDir.
//
// Usage: node host-run.mjs <host> <config.<host>.json> --state <local stateDir> [--parallel K] [--plan] [--collect-only]
//
// Starts the engine detached over ssh (a detached engine outlives the ssh session; an attached one dies with it), polls
// once a minute until it has exited, then rsyncs the per-issue and per-report files of the host's state dir into
// <local stateDir>/state/. The engine's output is printed with a `[<host>] ` prefix and kept in
// <local stateDir>/host-<host>.log. Exits 0 when a report was written, 1 when the engine exited with none or a step
// failed, and 255 when ssh dropped (the engine may still be running; the message gives the commands to resume).
// A `--plan` run only prints the read-only plan.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadHosts } from './lib/hosts.mjs';
import { stringOption, parseNumberOption } from './lib/cli-args.mjs';
import { SSH_OPTS, remoteCommand, shQuote } from './lib/remote.mjs';
import { configStateDir } from './lib/host-prepare.mjs';
import { engineCommand, outcome, parsePoll, pollDecision, pollScript, prefixLines, rsyncArgs } from './lib/host-run.mjs';
import { isMain } from './lib/is-main.mjs';

const USAGE = 'usage: host-run.mjs <host> <config.<host>.json> --state <local stateDir> [--parallel K] [--plan] [--collect-only]';
const POLL_MS = 60_000;
const CALL_MS = 120_000;

/** The real runner: `ssh(alias, command)` and `rsync(args)`, each returning `{ status, stdout, stderr }` and never throwing (a timeout is `status: null`). */
export const realRunner = () => ({
  ssh: (alias, command) => spawnSync('ssh', [...SSH_OPTS, alias, remoteCommand(command)], { encoding: 'utf8', timeout: CALL_MS }),
  rsync: (args) => spawnSync('rsync', args, { encoding: 'utf8', timeout: 600_000 }),
});

const dropped = (r) => r.status === 255 || r.status === null;

/**
 * Run (or, with `collectOnly`, only collect) one host's wave; returns the exit code. `host` is a validated hosts.json
 * entry and `stateDir` the host's state dir. `run` is the injected runner, `emit(text)` receives the engine's output and
 * `log(message)` host-run's own messages. `reattach` and `collect` are the commands a dropped connection prints. A report
 * already in the host's state dir counts as this run's: each wave has its own state dir.
 */
export async function hostRun({ name, host, stateDir, localState, parallel, plan, collectOnly, run, emit, log, sleep, reattach, collect }) {
  const engineLog = `${host.ssh}:${stateDir}/state/logs/orchestrator.log`;
  const finish = (kind, detail) => {
    const o = outcome(name, kind, { engineLog, reattach, collect, detail });
    if (o.message) log(o.message);
    return o.code;
  };
  const ssh = (command) => run.ssh(host.ssh, command);
  const show = (r) => emit(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  if (plan) {
    const r = ssh(engineCommand(host, stateDir, 'plan'));
    show(r);
    return dropped(r) ? finish('dropped') : finish(r.status === 0 ? 'done' : 'failed', `the plan exited ${r.status}`);
  }
  let pid;
  if (!collectOnly) {
    const r = ssh(engineCommand(host, stateDir, 'run', parallel));
    show(r);
    if (dropped(r)) return finish('dropped');
    pid = /\(PID (\d+)\)/.exec(r.stdout)?.[1];
    if (r.status !== 0 || !pid) return finish('failed', `the engine did not start (ssh exited ${r.status})`);
  }
  let offset = 0;
  let decision;
  do {
    const r = ssh(pollScript(stateDir, pid === undefined ? undefined : Number(pid), offset));
    if (dropped(r)) return finish('dropped');
    if (r.status !== 0) return finish('failed', `polling exited ${r.status}: ${r.stderr}`);
    const p = parsePoll(r.stdout);
    decision = pollDecision(p);
    // While the engine runs, leave a partial last line for the next poll so it is not split and prefixed twice.
    const chunk = decision === 'wait' ? p.log.slice(0, p.log.lastIndexOf('\n') + 1) : p.log;
    emit(chunk);
    offset += Buffer.byteLength(chunk);
    if (decision === 'wait') await sleep(POLL_MS);
  } while (decision === 'wait');
  const c = run.rsync(rsyncArgs(`${host.ssh}:${stateDir}/state/`, `${localState}/state/`));
  if (c.status === 255) return finish('dropped');
  return c.status === 0 ? finish(decision) : finish('failed', `rsync exited ${c.status}: ${c.stderr}`);
}

async function main(argv) {
  const flags = ['--state', '--parallel'];
  const unknown = argv.find((a) => a.startsWith('--') && ![...flags, '--plan', '--collect-only'].includes(a));
  if (unknown) throw new Error(`unknown option ${unknown}; ${USAGE}`);
  const [name, configPath, ...extra] = argv.filter((a, i) => !a.startsWith('--') && !flags.includes(argv[i - 1]));
  const state = stringOption(argv, '--state');
  if (!name || !configPath || extra.length || !state) throw new Error(USAGE);
  const hosts = loadHosts();
  if (!Object.hasOwn(hosts, name)) throw new Error(`unknown host ${JSON.stringify(name)}; known: ${Object.keys(hosts).join(', ') || 'none'}`);
  const host = hosts[name];
  const stateDir = configStateDir(JSON.parse(readFileSync(configPath, 'utf8')));
  if (!stateDir) throw new Error(`${configPath}: configDir and worktreeDir are not <dir>/state and a path under <dir>; pass the config emit-config --by-host wrote for ${name}`);
  const parallel = stringOption(argv, '--parallel') === undefined ? undefined : parseNumberOption('parallel', stringOption(argv, '--parallel'), { min: 1 });
  const logPath = `${state}/host-${name}.log`;
  mkdirSync(state, { recursive: true });
  writeFileSync(logPath, '');
  const here = `node ${shQuote(process.argv[1])} ${name} ${shQuote(configPath)} --state ${shQuote(state)}`;
  return hostRun({
    name, host, stateDir, localState: state, parallel, plan: argv.includes('--plan'), collectOnly: argv.includes('--collect-only'), run: realRunner(),
    emit: (text) => { process.stdout.write(prefixLines(name, text)); appendFileSync(logPath, text); },
    log: (m) => process.stderr.write(`${m}\n`),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    reattach: `ssh ${host.ssh} ${shQuote(engineCommand(host, stateDir, 'tail'))}`,
    collect: `${here} --collect-only`,
  });
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e.message}\n`); process.exitCode = 2; });
}
