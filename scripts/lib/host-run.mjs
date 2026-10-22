// host-run.mjs — the pure parts of running a wave's engine on a remote host and collecting its results: the remote
// command lines, the poll, the rsync file selection, the exit-code mapping and the output prefix. The CLI
// (scripts/host-run.mjs) runs them through an injected runner; nothing here touches a host.
import { EXIT, RSYNC_SSH, shQuote as q } from './remote.mjs';

/** The lease env a host's engine runs under, from its hosts.json entry; the remote resource preflight reads capacity under the same one. */
export const leaseEnv = (host) => ({ CO_HOME: host.coHome, CO_LEASE_HOOK: 'on', CO_LEASE_SESSION_SLOTS: host.sessionSlots ?? 1, CO_LEASE_SLOTS: host.leaseSlots ?? 1 });

const assign = (env) => Object.entries(env).map(([k, v]) => `${k}=${q(v)}`).join(' ');
const cap = (host, parallel) => Math.min(parallel ?? host.sessionSlots ?? 1, host.sessionSlots ?? 1);

/**
 * The engine command line for `host` (a validated hosts.json entry) with the config host-prepare placed at
 * `<stateDir>/config.json`: SKILL.md step 4b's line plus the host's lease env. `mode` is `run` (detached, `--parallel`
 * capped at the host's `sessionSlots`), `plan` (read-only) or `tail` (re-attach to the detached log). `sessionSlots`
 * and `leaseSlots` default to 1, as they are optional in hosts.json.
 */
export function engineCommand(host, stateDir, mode, parallel) {
  const env = { SHIP_DAG_CONFIG: `${stateDir}/config.json`, SHIP_DAG_PROJECT_ROOT: host.reposDir, ...leaseEnv(host) };
  const flags = { run: `--parallel ${cap(host, parallel)} --detach`, plan: '--plan', tail: '--tail' }[mode];
  return `${assign(env)} npx --prefix ${q(host.coHome)} tsx ${q(`${host.sdHome}/scripts/engine/run.mts`)} wave ${flags}`;
}

/** The host's resource preflight (`check --parallel` capped as `engineCommand` caps it) under `leaseEnv`, so it reads the session capacity the engine will run under. */
export const preflightCommand = (host, parallel) => `${assign(leaseEnv(host))} node ${q(`${host.sdHome}/scripts/resource-preflight.mjs`)} check --parallel ${cap(host, parallel)}`;

/** The most engine-log bytes one poll returns, so a poll's output stays far under the runner's buffer however long the log. */
export const LOG_CHUNK = 262_144;

/** The file, in the host's state dir (outside the `state/` that is collected), that holds the detached engine's pid. */
export const PID_FILE = 'host-run.pid';

/** The line the engine prints when `--detach` started it; its group is the detached engine's pid. */
export const DETACHED = /^Detached orchestrator \(PID (\d+)\)/m;

/**
 * `command` (an `engineCommand` run line) wrapped so that, when it exits 0 naming the detached pid, the pid is written to
 * `pidFile` on the host, where `--collect-only` finds it. The output (stderr folded in) and the exit code pass through.
 */
export function launchScript(command, pidFile) {
  const pid = `printf '%s\\n' "$out" | sed -n 's/^Detached orchestrator (PID \\([0-9][0-9]*\\)).*/\\1/p' | head -n 1`;
  return `out=$({ ${command}; } 2>&1); s=$?; printf '%s\\n' "$out"; pid=$(${pid}); if [ "$s" -eq 0 ] && [ -n "$pid" ]; then printf '%s\\n' "$pid" > ${q(pidFile)}; fi; exit "$s"`;
}

/**
 * The characters a host state dir may hold. host-run passes `<alias>:<stateDir>/state/` to rsync unquoted, because
 * rsync implementations disagree on a quoted remote path (openrsync strips the quotes, rsync >= 3.2.4 keeps them as part
 * of the path), so a dir with any other character is refused rather than quoted.
 */
export const RSYNC_SAFE_PATH = /^[A-Za-z0-9._/@+-]+$/;

/** A shell line that prints `reports=<n>`, the number of reports in `<stateDir>/state/reports`. */
export const reportsScript = (stateDir) => `echo reports=$(ls ${q(`${stateDir}/state/reports`)}/*.json 2>/dev/null | wc -l)`;

/** The count `reportsScript` printed (in `out`, a Buffer or string), or NaN when it printed none. */
export const parseReports = (out) => Number(/^reports=\s*(\d+)\s*$/m.exec(String(out))?.[1] ?? NaN);

/**
 * A shell line that prints `exists=0`, or (for a worktree at `path` that exists) `exists=1`, `commits=<n>` (ahead of
 * `origin/<base>`) and `dirty=<0|1>`. A git command that fails exits non-zero with no `exists=1`, so a missing worktree
 * is told from a failed read.
 */
export const worktreeScript = (path, base) => [
  `[ -d ${q(path)} ] || { echo exists=0; exit 0; }`,
  `c=$(git -C ${q(path)} rev-list --count ${q(`origin/${base}..HEAD`)}) || exit 1`,
  `d=$(git -C ${q(path)} status --porcelain) || exit 1`,
  `printf 'exists=1\\ncommits=%s\\ndirty=%s\\n' "$c" "$([ -n "$d" ] && echo 1 || echo 0)"`,
].join('; ');

/** `{ exists, commits, dirty }` (the shape `resumeMode` reads) from `worktreeScript` output (a Buffer or string), or undefined when it holds no recognizable state. */
export function parseWorktree(out) {
  const field = (k) => /^\s*(\d+)\s*$/.exec(new RegExp(`^${k}=(.*)$`, 'm').exec(String(out))?.[1] ?? '')?.[1];
  if (field('exists') === '0') return { exists: false, commits: 0, dirty: false };
  const [exists, commits, dirty] = ['exists', 'commits', 'dirty'].map(field);
  return exists === '1' && commits !== undefined && dirty !== undefined ? { exists: true, commits: Number(commits), dirty: dirty === '1' } : undefined;
}

/**
 * One poll of a detached run: whether the pid in `<stateDir>/host-run.pid` is alive (`none` without the file), how many
 * reports exist, then `---` and at most `LOG_CHUNK` bytes of the engine log from byte `offset`. Alive is read before
 * the log, so an engine seen exited has had its whole log written; a chunk of `LOG_CHUNK` bytes means more may follow.
 */
export function pollScript(stateDir, offset) {
  return [
    `pid=$(cat ${q(`${stateDir}/${PID_FILE}`)} 2>/dev/null)`,
    'if [ -z "$pid" ]; then echo alive=none; elif kill -0 "$pid" 2>/dev/null; then echo alive=1; else echo alive=0; fi',
    reportsScript(stateDir),
    'echo ---',
    `tail -c +${offset + 1} ${q(`${stateDir}/state/logs/orchestrator.log`)} 2>/dev/null | head -c ${LOG_CHUNK}; true`,
  ].join('; ');
}

/** Parse `pollScript` output (a Buffer or string) into `{ alive, reports, log }`: `alive` is null without a pid file, and `log` is the raw bytes. */
export function parsePoll(out) {
  const buf = Buffer.from(out);
  const cut = buf.indexOf('---\n');
  const head = Object.fromEntries(buf.subarray(0, cut).toString().split('\n').filter(Boolean).map((l) => l.split('=')));
  return { alive: { 1: true, 0: false }[head.alive] ?? null, reports: Number(head.reports), log: buf.subarray(cut + 4) };
}

/**
 * `wait` while the engine runs with no report. A report ends the wait once it was already there a poll ago
 * (`reportSeen`), since the engine writes the failure digests just after it, or at once when the engine has exited:
 * `done`. An engine that exited without one is `no-report`; with no pid file and no report it is `no-pid`.
 */
export function pollDecision({ alive, reports }, reportSeen) {
  if (alive === null) return reports > 0 ? 'done' : 'no-pid';
  if (alive) return reports > 0 && reportSeen ? 'done' : 'wait';
  return reports > 0 ? 'done' : 'no-report';
}

/**
 * The rsync argv that copies only the per-issue and per-report files of a state dir: `reports/`, `failure-digest/`,
 * `status/`, `metadata/` and `logs/issue-*`. The local engine of the same wave writes `orchestrator.pid`,
 * `logs/orchestrator.log`, `runs/` and `counters/` under the same `state/`, so none of them is ever copied.
 */
export const rsyncArgs = (src, dest) => [
  '-a', '-e', RSYNC_SSH,
  ...['reports', 'failure-digest', 'status', 'metadata'].flatMap((d) => [`--include=${d}/`, `--include=${d}/**`]),
  '--include=logs/', '--include=logs/issue-*', '--exclude=*', src, dest,
];

/**
 * The rsync argv that copies only `status/` and `metadata/` of a state dir: what each waiting poll copies into the local
 * collected dir, so the status board can read a remote ticket's stage while the host builds it. No report is copied, so
 * a mirror is never read as the wave's collected report.
 */
export const mirrorArgs = (src, dest) => [
  '-a', '-e', RSYNC_SSH,
  ...['status', 'metadata'].flatMap((d) => [`--include=${d}/`, `--include=${d}/**`]),
  '--exclude=*', src, dest,
];

/**
 * `{ code, message }` for how a host run ended (codes are `EXIT`'s): `done` (a report was written; 0), `no-report` (the
 * engine exited without one; 1), `dropped` (the ssh connection dropped, 255, which says nothing about the engine, so the
 * message gives the re-attach and `--collect-only` commands in `ctx.reattach`/`ctx.collect`), `stopped` (a local error after the launch, `ctx.detail`; 255 like `dropped`, with the same commands), `dropped-unstarted` (the
 * connection dropped during `ctx.step`, before any engine was started, so there is nothing to resume; 3), `no-pid` (no
 * `ctx.pidFile`, so whether the engine runs is unknown; 1), `timeout` (still running after `ctx.minutes`; 4, with
 * `ctx.collect` to resume) or `failed` (a step failed; 1).
 */
export function outcome(name, kind, ctx = {}) {
  return {
    done: { code: EXIT.ok },
    'no-report': { code: EXIT.failure, message: `host-run: ${name}: the engine exited with no report; see ${ctx.engineLog}` },
    'no-pid': { code: EXIT.failure, message: `host-run: ${name}: there is no ${ctx.pidFile} (host-run writes it when it starts the engine), so host-run cannot tell whether the engine is still running; it collected what is there and found no report` },
    timeout: { code: EXIT.waiting, message: `host-run: ${name}: the engine is still running after ${ctx.minutes} minutes; host-run stopped waiting, which is not an engine failure.\n  resume: ${ctx.collect}` },
    dropped: { code: EXIT.dropped, message: `host-run: ${name}: the ssh connection dropped; the engine may still be running there, so this is not an engine failure.\n  re-attach: ${ctx.reattach}\n  collect:   ${ctx.collect}` },
    stopped: { code: EXIT.dropped, message: `host-run: ${name}: ${ctx.detail}; the engine may still be running there, so this is not an engine failure.\n  re-attach: ${ctx.reattach}\n  collect:   ${ctx.collect}` },
    'dropped-unstarted': { code: EXIT.unreachable, message: `host-run: ${name}: the ssh connection dropped during ${ctx.step}; no engine was started, so there is nothing to resume.` },
    failed: { code: EXIT.failure, message: `host-run: ${name}: ${ctx.detail}` },
  }[kind];
}

/** `text` with `[name] ` before each line; a final line without a newline gets one. */
export const prefixLines = (name, text) => (text === '' ? '' : text.replace(/\n$/, '').split('\n').map((l) => `[${name}] ${l}\n`).join(''));
