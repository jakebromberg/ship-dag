// host-run.mjs — the pure parts of running a wave's engine on a remote host and collecting its results: the remote
// command lines, the poll, the rsync file selection, the exit-code mapping and the output prefix. The CLI
// (scripts/host-run.mjs) runs them through an injected runner; nothing here touches a host.
import { SSH_OPTS, shQuote as q } from './remote.mjs';

/**
 * The engine command line for `host` (a validated hosts.json entry) with the config host-prepare placed at
 * `<stateDir>/config.json`: SKILL.md step 4b's line plus the host's lease env. `mode` is `run` (detached, `--parallel`
 * capped at the host's `sessionSlots`), `plan` (read-only) or `tail` (re-attach to the detached log). `sessionSlots`
 * and `leaseSlots` default to 1, as they are optional in hosts.json.
 */
export function engineCommand(host, stateDir, mode, parallel) {
  const sessions = host.sessionSlots ?? 1;
  const env = { SHIP_DAG_CONFIG: `${stateDir}/config.json`, SHIP_DAG_PROJECT_ROOT: host.reposDir, CO_HOME: host.coHome, CO_LEASE_HOOK: 'on', CO_LEASE_SESSION_SLOTS: sessions, CO_LEASE_SLOTS: host.leaseSlots ?? 1 };
  const flags = { run: `--parallel ${Math.min(parallel ?? sessions, sessions)} --detach`, plan: '--plan', tail: '--tail' }[mode];
  const assigns = Object.entries(env).map(([k, v]) => `${k}=${q(v)}`).join(' ');
  return `${assigns} npx --prefix ${q(host.coHome)} tsx ${q(`${host.sdHome}/scripts/engine/run.mts`)} wave ${flags}`;
}

/**
 * One poll of a detached run: whether `pid` is alive, how many reports exist, then `---` and the engine log from byte
 * `offset`. A `pid` that is not an integer (none, for a `--collect-only` look at a finished run) reads as exited. Alive is read before the log,
 * so an engine seen exited has had its whole log read.
 */
export function pollScript(stateDir, pid, offset) {
  const state = `${stateDir}/state`;
  return [
    Number.isInteger(pid) ? `echo alive=$(kill -0 ${pid} 2>/dev/null && echo 1 || echo 0)` : 'echo alive=0',
    `echo reports=$(ls ${q(`${state}/reports`)}/*.json 2>/dev/null | wc -l)`,
    'echo ---',
    `tail -c +${offset + 1} ${q(`${state}/logs/orchestrator.log`)} 2>/dev/null; true`,
  ].join('; ');
}

/** Parse `pollScript` output into `{ alive, reports, log }`. */
export function parsePoll(out) {
  const cut = out.indexOf('---\n');
  const head = Object.fromEntries(out.slice(0, cut).split('\n').filter(Boolean).map((l) => l.split('=')));
  return { alive: head.alive === '1', reports: Number(head.reports), log: out.slice(cut + 4) };
}

/** `wait` while the engine runs; once it has exited, `done` if a report exists, else `no-report`. */
export const pollDecision = ({ alive, reports }) => (alive ? 'wait' : reports > 0 ? 'done' : 'no-report');

/**
 * The rsync argv that copies only the per-issue and per-report files of a state dir: `reports/`, `failure-digest/`,
 * `status/`, `metadata/` and `logs/issue-*`. The local engine of the same wave writes `orchestrator.pid`,
 * `logs/orchestrator.log`, `runs/` and `counters/` under the same `state/`, so none of them is ever copied.
 */
export const rsyncArgs = (src, dest) => [
  '-a', '-e', ['ssh', ...SSH_OPTS].join(' '),
  ...['reports', 'failure-digest', 'status', 'metadata'].flatMap((d) => [`--include=${d}/`, `--include=${d}/**`]),
  '--include=logs/', '--include=logs/issue-*', '--exclude=*', src, dest,
];

/**
 * `{ code, message }` for how a host run ended: `done` (a report was written; 0), `no-report` (the engine exited
 * without one; 1), `dropped` (the ssh connection dropped, 255, which says nothing about the engine, so the message gives
 * the re-attach and `--collect-only` commands in `ctx.reattach`/`ctx.collect`) or `failed` (a step failed; 1).
 */
export function outcome(name, kind, ctx = {}) {
  return {
    done: { code: 0 },
    'no-report': { code: 1, message: `host-run: ${name}: the engine exited with no report; see ${ctx.engineLog}` },
    dropped: { code: 255, message: `host-run: ${name}: the ssh connection dropped; the engine may still be running there, so this is not an engine failure.\n  re-attach: ${ctx.reattach}\n  collect:   ${ctx.collect}` },
    failed: { code: 1, message: `host-run: ${name}: ${ctx.detail}` },
  }[kind];
}

/** `text` with `[name] ` before each line; a final line without a newline gets one. */
export const prefixLines = (name, text) => (text === '' ? '' : text.replace(/\n$/, '').split('\n').map((l) => `[${name}] ${l}\n`).join(''));
