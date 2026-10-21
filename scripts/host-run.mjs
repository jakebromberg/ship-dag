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
// message gives the commands to resume). A run refuses to start on a host state dir that already holds a report (each
// wave needs its own state dir). `--collect-only` starts nothing and resumes the same wait on the recorded pid. A
// `--plan` run only prints the read-only plan.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHosts } from './lib/hosts.mjs';
import { stringOption, parseNumberOption } from './lib/cli-args.mjs';
import { SSH_MAX_BUFFER, SSH_OPTS, callFailure, remoteCommand, shQuote, sshCommandLine } from './lib/remote.mjs';
import { configStateDir } from './lib/host-prepare.mjs';
import { DETACHED, LOG_CHUNK, PID_FILE, RSYNC_SAFE_PATH, engineCommand, launchScript, outcome, parsePoll, parseReports, pollDecision, pollScript, prefixLines, reportsScript, rsyncArgs } from './lib/host-run.mjs';
import { isMain } from './lib/is-main.mjs';

const USAGE = 'usage: host-run.mjs <host> <config.<host>.json> --state <local stateDir> [--parallel K] [--max-wait <minutes>] [--plan] [--collect-only]';
const MINUTE = 60_000;
const POLL_MS = MINUTE;
const CALL_MS = 2 * MINUTE;
const MAX_WAIT_MINUTES = 360;

/**
 * The real runner: `ssh(alias, command)` (stdout and stderr as Buffers) and `rsync(args)`, each returning spawnSync's
 * `{ status, stdout, stderr, error }` and never throwing. A call past its timeout or buffer has `status: null` and an
 * `error` whose `code` is `ETIMEDOUT` or `ENOBUFS`.
 */
export const realRunner = () => ({
  ssh: (alias, command) => spawnSync('ssh', [...SSH_OPTS, alias, remoteCommand(command)], { timeout: CALL_MS, maxBuffer: SSH_MAX_BUFFER }),
  rsync: (args) => spawnSync('rsync', args, { encoding: 'utf8', timeout: 10 * MINUTE, maxBuffer: SSH_MAX_BUFFER }),
});

/**
 * Run (or, with `collectOnly`, only wait for and collect) one host's wave; returns the exit code. `host` is a validated
 * hosts.json entry and `stateDir` the host's state dir. `run` is the injected runner, `emit(chunk)` receives the
 * engine's output (a string or the raw log bytes) and `log(message)` host-run's own messages; `sleep(ms)` and `now()`
 * pace the polls and the `maxWaitMs` deadline. `reattach` and `collect` are the commands a dropped connection or the
 * deadline prints. A host state dir with a character outside `RSYNC_SAFE_PATH` is refused before any call. A run
 * refuses to start when the host state dir already holds a report, since the wait could not tell it from this run's;
 * `--collect-only` resumes the recorded launch whatever the dir holds.
 */
export async function hostRun({ name, host, stateDir, localState, parallel, plan, collectOnly, maxWaitMs = MAX_WAIT_MINUTES * MINUTE, run, emit, log, sleep, now = Date.now, reattach, collect }) {
  const engineLog = `${host.ssh}:${stateDir}/state/logs/orchestrator.log`;
  const pidFile = `${stateDir}/${PID_FILE}`;
  const finish = (kind, detail, step) => {
    const o = outcome(name, kind, { engineLog, reattach, collect, detail, step, pidFile, minutes: maxWaitMs / MINUTE });
    if (o.message) log(o.message);
    return o.code;
  };
  // The exit code for a call that did not run to completion, else undefined. A drop before the launch started nothing.
  const halted = (step, r, unstarted = false) => {
    const why = callFailure(r);
    if (why === 'dropped') return unstarted ? finish('dropped-unstarted', undefined, step) : finish('dropped');
    return why ? finish('failed', `${step} failed: ${why}`) : undefined;
  };
  if (!RSYNC_SAFE_PATH.test(stateDir)) {
    return finish('failed', `the host state dir ${stateDir} has a character outside [A-Za-z0-9._/@+-]; host-run passes it to rsync unquoted, since rsync versions disagree on a quoted remote path, so it starts nothing. Emit the config with a state dir made of those characters.`);
  }
  const ssh = (command) => run.ssh(host.ssh, command);
  const show = (r) => emit(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  if (plan) {
    const r = ssh(engineCommand(host, stateDir, 'plan'));
    show(r);
    return halted('the plan', r, true) ?? finish(r.status === 0 ? 'done' : 'failed', `the plan exited ${r.status}`);
  }
  if (!collectOnly) {
    const check = ssh(reportsScript(stateDir));
    const reports = parseReports(check.stdout);
    const refused = halted('the report check', check, true)
      ?? (check.status !== 0 || !(reports >= 0) ? finish('failed', `the report check exited ${check.status}: ${check.stderr}`) : undefined)
      ?? (reports > 0 ? finish('failed', `${host.ssh}:${stateDir} already holds a report, which the wait could not tell from this launch's; each wave needs its own state dir (e.g. a suffixed <runId>-w<N> one, emitted and prepared again), so host-run started nothing`) : undefined);
    if (refused !== undefined) return refused;
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
  // Unquoted: stateDir holds only RSYNC_SAFE_PATH characters, checked above.
  const c = run.rsync(rsyncArgs(`${host.ssh}:${stateDir}/state/`, `${localState}/state/`));
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
  // Absolute paths, so the printed command works from any directory, and the same --max-wait.
  const here = `node ${shQuote(fileURLToPath(import.meta.url))} ${shQuote(name)} ${shQuote(resolve(configPath))} --state ${shQuote(resolve(state))} --max-wait ${maxWait}`;
  return hostRun({
    name, host, stateDir, localState: state, parallel, plan, collectOnly: argv.includes('--collect-only'), maxWaitMs: maxWait * MINUTE, run, sleep, now,
    // The host log keeps a run's and every resumed --collect-only's output; a --plan is not a run and leaves it alone.
    emit: (chunk) => { out(prefixLines(name, String(chunk))); if (!plan) appendFileSync(logPath, chunk); },
    log: (m) => err(`${m}\n`),
    reattach: sshCommandLine(host.ssh, engineCommand(host, stateDir, 'tail')),
    collect: `${here} --collect-only`,
  });
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e.message}\n`); process.exitCode = 2; });
}
