#!/usr/bin/env node
// host-run.mjs — run a wave's engine on a remote host and collect its reports and logs into the local stateDir.
//
// Usage: node host-run.mjs <host> <config.<host>.json> --state <local stateDir> [--parallel K] [--max-wait <minutes>] [--plan | --preflight | --collect-only | --worktree <path> --base <branch>]
//
// Starts the engine detached over ssh (a detached engine outlives the ssh session; an attached one dies with it) and
// records its pid in <host stateDir>/host-run.pid, polls once a minute until the engine has exited or its report has
// been there for a poll, then rsyncs the per-issue and per-report files of the host's state dir into
// <local stateDir>/state/; while it waits, each poll also copies the host's status/ and metadata/ there and records the
// copy in <local stateDir>/host-mirror.json, for the status board. The engine's output is printed with a `[<host>] ` prefix and appended to
// <local stateDir>/host-<host>.log. Exits 0 when a report was written, 1 when the engine exited with none or a step
// failed, 2 on usage, 3 when ssh dropped before any engine started (nothing to resume), 4 when --max-wait (default 360
// minutes) passed with the engine still running, and 255 when ssh dropped, or a local error threw, after the launch (the engine may still be
// running; the message gives the commands to resume). A run refuses to start on a host state dir that already holds a report (each
// wave needs its own state dir). `--collect-only` starts nothing and resumes the same wait on the recorded pid. A
// `--plan` run only prints the read-only plan. A `--preflight` run prints the host's resource-preflight JSON (run under the
// engine's lease env, `--parallel` capped at the host's sessionSlots) and nothing else; it exits 3 when ssh dropped. A
// `--worktree <path> --base <branch>` run makes one read of that host worktree and prints `{"exists":..,"commits":..,"dirty":..}`
// (commits ahead of origin/<base>, as SKILL.md step 5 reads them): 0 when it read (a missing worktree is `exists: false`), 3 when
// ssh dropped, 1 when the read failed; it launches nothing, so no failure of it is a 255.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfiles } from './lib/ci-profile.mjs';
import { loadHosts } from './lib/hosts.mjs';
import { configToolchains } from './lib/split-by-host.mjs';
import { stringOption, parseNumberOption } from './lib/cli-args.mjs';
import { EXIT, SSH_MAX_BUFFER, SSH_OPTS, UsageError, asUsage, callFailure, remoteCommand, runCli, shQuote, sshCommandLine } from './lib/remote.mjs';
import { configStateDir } from './lib/host-prepare.mjs';
import { DETACHED, LOG_CHUNK, MIRROR_FILE, PID_FILE, RSYNC_SAFE_PATH, engineCommand, mirrorArgs, mirrorRecord, launchScript, outcome, parsePoll, parseReports, pollDecision, pollScript, preflightCommand, prefixLines, reportsScript, rsyncArgs, parseWorktree, worktreeScript } from './lib/host-run.mjs';
import { isMain } from './lib/is-main.mjs';

const USAGE = 'usage: host-run.mjs <host> <config.<host>.json> --state <local stateDir> [--parallel K] [--max-wait <minutes>] [--plan | --preflight | --collect-only | --worktree <path> --base <branch>]';
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
 * deadline prints. A throw once the launch has started (or, for `--collect-only`, once the wait has) exits 255 with those commands, as a dropped connection does; an earlier throw rejects. `preflight` runs only the host's resource preflight (its stdout is `emit`ted unprefixed, its stderr `log`ged). `oneAtATime` (the wave holds an Xcode repo) runs one session whatever `--parallel` says or omits, and logs
 * the clamp: two xcodebuild runs share DerivedData, simulators and an 8 GB host's memory and disk. A host state dir with a character outside `RSYNC_SAFE_PATH` is refused before any call. A run
 * refuses to start when the host state dir already holds a report, since the wait could not tell it from this run's;
 * `--collect-only` resumes the recorded launch whatever the dir holds. While it waits, each poll that finds the engine
 * running also copies the host's `status/` and `metadata/` into `<localState>/state/` (`mirrorArgs`), for the status
 * board; `record(ok, at)` is told of each copy, the final collect included, and of a poll that failed (`ok` false).
 */
export async function hostRun(args) {
  let launched = false;
  try {
    return await drive(args, () => { launched = true; });
  } catch (e) {
    if (!launched) throw e;
    // The engine may be running: never relaunch, resume with --collect-only.
    const o = outcome(args.name, 'stopped', { reattach: args.reattach, collect: args.collect, detail: e.message });
    args.log(o.message);
    return o.code;
  }
}

/** `hostRun`'s steps; calls `launching()` as the launch starts (or, for `--collect-only`, once the recorded one is being waited on), so a throw after it is known to follow a launch. */
async function drive({ name, host, stateDir, localState, parallel, oneAtATime = false, plan, preflight, collectOnly, maxWaitMs = MAX_WAIT_MINUTES * MINUTE, run, emit, log, sleep, now = Date.now, reattach, collect, record = () => {} }, launching) {
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
  if (preflight) {
    const r = ssh(preflightCommand(host, parallel));
    emit(r.stdout ?? '');
    if (r.stderr?.length) log(String(r.stderr).trimEnd());
    return halted('the preflight', r, true) ?? finish(r.status === 0 ? 'done' : 'failed', `the preflight exited ${r.status}`);
  }
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
    const wanted = parallel ?? host.sessionSlots ?? 1;
    if (oneAtATime && Math.min(wanted, host.sessionSlots ?? 1) > 1) log(`host-run: ${name}: the wave needs the xcode toolchain, which runs one session at a time (xcodebuild runs share DerivedData and simulators, and the host's memory and disk); clamping --parallel from ${Math.min(wanted, host.sessionSlots ?? 1)} to 1.`);
    launching();
    const r = ssh(launchScript(engineCommand(host, stateDir, 'run', oneAtATime ? 1 : parallel), pidFile));
    show(r);
    const stop = halted('the launch', r)
      ?? (r.status !== 0 ? finish('failed', `the engine did not start (ssh exited ${r.status})`) : undefined)
      ?? (DETACHED.test(String(r.stdout ?? '')) ? undefined : finish('failed', 'the engine did not start: its output names no PID'));
    if (stop !== undefined) return stop;
  }
  launching();
  const start = now();
  let offset = 0;
  let reportSeen = false;
  let decision;
  for (;;) {
    const r = ssh(pollScript(stateDir, offset));
    if (callFailure(r) || r.status !== 0) record(false, new Date(now()).toISOString());
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
    const m = run.rsync(mirrorArgs(`${host.ssh}:${stateDir}/state/`, `${localState}/state/`));
    const why = callFailure(m) ?? (m.status !== 0 ? `rsync exited ${m.status}: ${m.stderr}` : undefined);
    record(!why, new Date(now()).toISOString());
    if (why) log(`host-run: ${name}: could not copy the host's engine state for the board (${why}); the wait goes on`);
    if (now() - start >= maxWaitMs) return finish('timeout');
    reportSeen = p.reports > 0;
    await sleep(POLL_MS);
  }
  // Unquoted: stateDir holds only RSYNC_SAFE_PATH characters, checked above.
  const c = run.rsync(rsyncArgs(`${host.ssh}:${stateDir}/state/`, `${localState}/state/`));
  if (!callFailure(c) && c.status === 0) record(true, new Date(now()).toISOString());
  return halted('rsync', c) ?? (c.status === 0 ? finish(decision) : finish('failed', `rsync exited ${c.status}: ${c.stderr}`));
}

/** One read of `host`'s worktree at `path` against `origin/<base>`: prints its state JSON to `out` and returns the exit code (a drop is `EXIT.unreachable`, a failed read `EXIT.failure`), `err(text)` getting the reason. */
function readWorktree(host, path, base, run, out, err) {
  const r = run.ssh(host.ssh, worktreeScript(path, base));
  const why = callFailure(r);
  const state = why || r.status !== 0 ? undefined : parseWorktree(r.stdout);
  if (state) out(`${JSON.stringify(state)}\n`);
  else err(`host-run: ${host.ssh}: ${why === 'dropped' ? 'the ssh connection dropped' : why ?? (r.status !== 0 ? `the worktree read exited ${r.status}: ${r.stderr}` : 'the worktree read printed no worktree state')}\n`);
  return state ? EXIT.ok : why === 'dropped' ? EXIT.unreachable : EXIT.failure;
}

/**
 * The CLI: parse `argv` (as in USAGE) and run `hostRun`; resolves to the exit code. `hosts`, `run`, `out`, `err`,
 * `sleep`, `now` and `profiles` default to the registry, the real runner, the process's streams and the real clock.
 */
export async function main(argv, { hosts, loadHosts: load = loadHosts, run = realRunner(), out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, profiles = loadProfiles() } = {}) {
  const flags = ['--state', '--parallel', '--max-wait', '--worktree', '--base'];
  const unknown = argv.find((a) => a.startsWith('--') && ![...flags, '--plan', '--preflight', '--collect-only'].includes(a));
  if (unknown) throw new UsageError(`unknown option ${unknown}; ${USAGE}`);
  const [name, configPath, ...extra] = argv.filter((a, i) => !a.startsWith('--') && !flags.includes(argv[i - 1]));
  const state = asUsage(() => stringOption(argv, '--state'));
  if (!name || !configPath || extra.length || !state) throw new UsageError(USAGE);
  const number = (flag) => (stringOption(argv, `--${flag}`) === undefined ? undefined : parseNumberOption(flag, stringOption(argv, `--${flag}`), { min: 1 }));
  const [parallel, maxWait = MAX_WAIT_MINUTES] = asUsage(() => [number('parallel'), number('max-wait')]);
  // Usage errors first: they exit 2 whatever hosts.json and the config hold.
  const [worktree, base] = asUsage(() => [stringOption(argv, '--worktree'), stringOption(argv, '--base')]);
  if ((worktree === undefined) !== (base === undefined)) throw new UsageError(`--worktree and --base go together; ${USAGE}`);
  const modes = ['plan', 'preflight', 'collect-only', 'worktree'].filter((m) => (m === 'worktree' ? worktree !== undefined : argv.includes(`--${m}`)));
  if (modes.length > 1) throw new UsageError(`${modes.map((m) => `--${m}`).join(' and ')} are alternatives; give one. ${USAGE}`);
  const mode = modes[0] ?? 'run';
  const registry = hosts ?? load();
  if (!Object.hasOwn(registry, name)) throw new UsageError(`unknown host ${JSON.stringify(name)}; known: ${Object.keys(registry).join(', ') || 'none'}`);
  const host = registry[name];
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const stateDir = configStateDir(config);
  if (!stateDir) throw new UsageError(`${configPath}: configDir and worktreeDir are not <dir>/state and a path under <dir>; pass the config emit-config --by-host wrote for ${name}`);
  const preflight = mode === 'preflight';
  const plan = mode === 'plan';
  const readOnly = ['plan', 'preflight', 'worktree'].includes(mode);
  const logPath = `${state}/host-${name}.log`;
  const mirrorPath = `${state}/${MIRROR_FILE}`;
  const prevMirror = () => { try { return JSON.parse(readFileSync(mirrorPath, 'utf8')); } catch { return null; } };
  if (!readOnly) mkdirSync(state, { recursive: true });
  // Before hostRun: nothing is launched, so a failed read exits 1 through runCli and never routes to --collect-only.
  if (mode === 'worktree') return readWorktree(host, worktree, base, run, out, err);
  // Absolute paths, so the printed command works from any directory, and the same --max-wait.
  const here = `node ${shQuote(fileURLToPath(import.meta.url))} ${shQuote(name)} ${shQuote(resolve(configPath))} --state ${shQuote(resolve(state))} --max-wait ${maxWait}`;
  return hostRun({
    name, host, stateDir, localState: state, parallel, oneAtATime: configToolchains(config, profiles).includes('xcode'), plan, preflight, collectOnly: mode === 'collect-only', maxWaitMs: maxWait * MINUTE, run, sleep, now,
    // The host log keeps a run's and every resumed --collect-only's output; a --plan or --preflight is not a run and leaves it alone.
    emit: (chunk) => { out(preflight ? String(chunk) : prefixLines(name, String(chunk))); if (!readOnly) appendFileSync(logPath, chunk); },
    log: (m) => err(`${m}\n`),
    reattach: sshCommandLine(host.ssh, engineCommand(host, stateDir, 'tail')),
    collect: `${here} --collect-only`,
    // For the board (board/remote.mjs): which host the collected dir's state/ came from, and how fresh it is.
    // A record that cannot be written costs the board its freshness note, never the wait.
    record: (ok, at) => {
      try { writeFileSync(mirrorPath, `${JSON.stringify(mirrorRecord(prevMirror(), name, ok, at))}\n`); } catch (e) { err(`host-run: ${name}: could not write ${mirrorPath}: ${e.message}\n`); }
    },
  });
}

/** `main` under the shared entry wrapper: resolves to the exit code for `argv`, errors written to `deps.err`. */
export const cli = (argv, deps) => runCli(main, argv, deps);

if (isMain(import.meta.url)) {
  cli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
