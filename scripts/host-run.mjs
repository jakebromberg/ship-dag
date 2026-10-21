#!/usr/bin/env node
// host-run.mjs — run a wave's engine on a remote host and collect its reports and logs into the local stateDir.
//
// Usage: node host-run.mjs <host> <config.<host>.json> --state <local stateDir> [--parallel K] [--max-wait <minutes>] [--plan] [--collect-only]
//
// Starts the engine detached over ssh (a detached engine outlives the ssh session; an attached one dies with it) and
// records its pid in <host stateDir>/host-run.pid, polls once a minute until the engine has exited or its report has
// been there for a poll, then rsyncs the per-issue and per-report files of the host's state dir into
// <local stateDir>/state/. The engine's output is printed with a `[<host>] ` prefix and appended to
// <local stateDir>/host-<host>.log. Exits 0 when a report was written, 1 when the engine exited with none, a step
// failed or --max-wait (default 360 minutes) passed, and 255 when ssh dropped (the engine may still be running; the
// message gives the commands to resume). `--collect-only` starts nothing and resumes the same wait on the recorded pid.
// A `--plan` run only prints the read-only plan.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadHosts } from './lib/hosts.mjs';
import { stringOption, parseNumberOption } from './lib/cli-args.mjs';
import { SSH_OPTS, remoteCommand, shQuote } from './lib/remote.mjs';
import { configStateDir } from './lib/host-prepare.mjs';
import { DETACHED, LOG_CHUNK, PID_FILE, engineCommand, launchScript, outcome, parsePoll, pollDecision, pollScript, prefixLines, rsyncArgs } from './lib/host-run.mjs';
import { isMain } from './lib/is-main.mjs';

const USAGE = 'usage: host-run.mjs <host> <config.<host>.json> --state <local stateDir> [--parallel K] [--max-wait <minutes>] [--plan] [--collect-only]';
const MINUTE = 60_000;
const POLL_MS = MINUTE;
const CALL_MS = 2 * MINUTE;
const MAX_WAIT_MINUTES = 360;
// A poll returns at most LOG_CHUNK log bytes; the rest of the buffer is headroom for the launch and plan output.
const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * The real runner: `ssh(alias, command)` (stdout and stderr as Buffers) and `rsync(args)`, each returning spawnSync's
 * `{ status, stdout, stderr, error }` and never throwing. A call past its timeout or buffer has `status: null` and an
 * `error` whose `code` is `ETIMEDOUT` or `ENOBUFS`.
 */
export const realRunner = () => ({
  ssh: (alias, command) => spawnSync('ssh', [...SSH_OPTS, alias, remoteCommand(command)], { timeout: CALL_MS, maxBuffer: MAX_BUFFER }),
  rsync: (args) => spawnSync('rsync', args, { encoding: 'utf8', timeout: 10 * MINUTE, maxBuffer: MAX_BUFFER }),
});

/**
 * How a call failed to run, or undefined: `dropped` for ssh's own exit 255 or a call that hit its timeout (the
 * connection, not the remote command), else the message of the error that stopped it (an overflowed buffer, a missing
 * binary).
 */
const broken = (r) => (r.status === 255 || r.error?.code === 'ETIMEDOUT' ? 'dropped' : r.error?.message);

/**
 * Run (or, with `collectOnly`, only wait for and collect) one host's wave; returns the exit code. `host` is a validated
 * hosts.json entry and `stateDir` the host's state dir. `run` is the injected runner, `emit(chunk)` receives the
 * engine's output (a string or the raw log bytes) and `log(message)` host-run's own messages; `sleep(ms)` and `now()`
 * pace the polls and the `maxWaitMs` deadline. `reattach` and `collect` are the commands a dropped connection or the
 * deadline prints. A report already in the host's state dir counts as this run's: each wave has its own state dir.
 */
export async function hostRun({ name, host, stateDir, localState, parallel, plan, collectOnly, maxWaitMs = MAX_WAIT_MINUTES * MINUTE, run, emit, log, sleep, now = Date.now, reattach, collect }) {
  const engineLog = `${host.ssh}:${stateDir}/state/logs/orchestrator.log`;
  const pidFile = `${stateDir}/${PID_FILE}`;
  const finish = (kind, detail) => {
    const o = outcome(name, kind, { engineLog, reattach, collect, detail, pidFile, minutes: maxWaitMs / MINUTE });
    if (o.message) log(o.message);
    return o.code;
  };
  // The exit code for a call that did not run to completion, else undefined.
  const halted = (step, r) => {
    const why = broken(r);
    return why === 'dropped' ? finish('dropped') : why ? finish('failed', `${step} failed: ${why}`) : undefined;
  };
  const ssh = (command) => run.ssh(host.ssh, command);
  const show = (r) => emit(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  if (plan) {
    const r = ssh(engineCommand(host, stateDir, 'plan'));
    show(r);
    return halted('the plan', r) ?? finish(r.status === 0 ? 'done' : 'failed', `the plan exited ${r.status}`);
  }
  if (!collectOnly) {
    const r = ssh(launchScript(engineCommand(host, stateDir, 'run', parallel), pidFile));
    show(r);
    const stop = halted('the launch', r)
      ?? (r.status !== 0 ? finish('failed', `the engine did not start (ssh exited ${r.status})`) : undefined)
      ?? (DETACHED.test(String(r.stdout ?? '')) ? undefined : finish('failed', 'the engine did not start: its output names no PID'));
    if (stop !== undefined) return stop;
  }
  const start = now();
  let offset = 0;
  let reportSeen = false;
  let decision;
  for (;;) {
    const r = ssh(pollScript(stateDir, offset));
    const stop = halted('polling', r) ?? (r.status !== 0 ? finish('failed', `polling exited ${r.status}: ${r.stderr}`) : undefined);
    if (stop !== undefined) return stop;
    const p = parsePoll(r.stdout);
    decision = pollDecision(p, reportSeen);
    const more = p.log.length >= LOG_CHUNK;
    // Until the log is read to its end with the run over, leave a partial last line for the next poll so it is not split
    // and prefixed twice (a whole chunk with no newline at all goes out as is).
    const end = decision === 'wait' || more ? p.log.lastIndexOf(0x0a) + 1 || (more ? p.log.length : 0) : p.log.length;
    const chunk = p.log.subarray(0, end);
    emit(chunk);
    offset += chunk.length;
    if (more) continue;
    if (decision !== 'wait') break;
    if (now() - start >= maxWaitMs) return finish('timeout');
    reportSeen = p.reports > 0;
    await sleep(POLL_MS);
  }
  const c = run.rsync(rsyncArgs(`${host.ssh}:${shQuote(`${stateDir}/state/`)}`, `${localState}/state/`));
  return halted('rsync', c) ?? (c.status === 0 ? finish(decision) : finish('failed', `rsync exited ${c.status}: ${c.stderr}`));
}

/**
 * The CLI: parse `argv` (as in USAGE) and run `hostRun`; resolves to the exit code. `hosts`, `run`, `out`, `err`,
 * `sleep` and `now` default to the registry, the real runner, the process's streams and the real clock.
 */
export async function main(argv, { hosts, run = realRunner(), out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const flags = ['--state', '--parallel', '--max-wait'];
  const unknown = argv.find((a) => a.startsWith('--') && ![...flags, '--plan', '--collect-only'].includes(a));
  if (unknown) throw new Error(`unknown option ${unknown}; ${USAGE}`);
  const [name, configPath, ...extra] = argv.filter((a, i) => !a.startsWith('--') && !flags.includes(argv[i - 1]));
  const state = stringOption(argv, '--state');
  if (!name || !configPath || extra.length || !state) throw new Error(USAGE);
  const number = (flag) => (stringOption(argv, `--${flag}`) === undefined ? undefined : parseNumberOption(flag, stringOption(argv, `--${flag}`), { min: 1 }));
  const parallel = number('parallel');
  const maxWait = number('max-wait') ?? MAX_WAIT_MINUTES;
  const registry = hosts ?? loadHosts();
  if (!Object.hasOwn(registry, name)) throw new Error(`unknown host ${JSON.stringify(name)}; known: ${Object.keys(registry).join(', ') || 'none'}`);
  const host = registry[name];
  const stateDir = configStateDir(JSON.parse(readFileSync(configPath, 'utf8')));
  if (!stateDir) throw new Error(`${configPath}: configDir and worktreeDir are not <dir>/state and a path under <dir>; pass the config emit-config --by-host wrote for ${name}`);
  const plan = argv.includes('--plan');
  const logPath = `${state}/host-${name}.log`;
  if (!plan) mkdirSync(state, { recursive: true });
  const here = `node ${shQuote(fileURLToPath(import.meta.url))} ${shQuote(name)} ${shQuote(configPath)} --state ${shQuote(state)}`;
  return hostRun({
    name, host, stateDir, localState: state, parallel, plan, collectOnly: argv.includes('--collect-only'), maxWaitMs: maxWait * MINUTE, run, sleep, now,
    // The host log keeps a run's and every resumed --collect-only's output; a --plan is not a run and leaves it alone.
    emit: (chunk) => { out(prefixLines(name, String(chunk))); if (!plan) appendFileSync(logPath, chunk); },
    log: (m) => err(`${m}\n`),
    reattach: `ssh ${shQuote(host.ssh)} ${shQuote(engineCommand(host, stateDir, 'tail'))}`,
    collect: `${here} --collect-only`,
  });
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e.message}\n`); process.exitCode = 2; });
}
