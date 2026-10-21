// remote.mjs — the one place that holds how a command runs on a hosts.json host: ssh options, the output buffer, the
// `rsync -e` value, shell quoting, the remote shell, the printable ssh line and the drop classifier. host-prepare,
// host-run and host-sync-claude use it instead of carrying their own copy.

// Never prompt for a password or host key, and give up on an unreachable host. Used by every ssh, scp and `rsync -e`.
export const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];

/** The output an ssh or rsync call may return: past the 1 MiB default for a large settings.json probe or a poll's log chunk. */
export const SSH_MAX_BUFFER = 16 * 1024 * 1024;

/** The `rsync -e` value: ssh with the same options as every other call. */
export const RSYNC_SSH = ['ssh', ...SSH_OPTS].join(' ');

/** `s` (coerced with String()) as one POSIX single-quoted shell word. */
export const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * `cmd`, to run over ssh on a host and find node, gh and claude. It is returned unchanged: over plain non-interactive
 * ssh, `command -v node gh claude` on funlandresearch resolves all three to /Users/jake/.local/bin, which ~/.zshenv
 * puts on PATH ($SHELL is /bin/zsh; /opt/homebrew/bin exists but holds none of them), checked 2026-10-21. A login
 * shell (`$SHELL -lc`) is not needed there; a host whose .zshenv lacks the PATH would need it added here, once.
 */
export const remoteCommand = (cmd) => cmd;

/** The printable command line that runs `command` on `alias` over ssh. */
export const sshCommandLine = (alias, command) => `ssh ${SSH_OPTS.join(' ')} ${shQuote(alias)} ${shQuote(remoteCommand(command))}`;

/**
 * How a spawnSync-shaped result `r`, or an error execFileSync threw (`status` and `code` on the error itself), failed to
 * run, or undefined: `dropped` for ssh's own exit 255 or a call that hit its timeout (the connection, not the remote
 * command), else the message of the error that stopped it (an overflowed buffer, a missing binary).
 */
export const callFailure = (r) => {
  const e = r.error ?? r;
  return r.status === 255 || e.code === 'ETIMEDOUT' ? 'dropped' : e.message;
};

/**
 * The exit codes of host-prepare, host-sync-claude and host-run. `unreachable` is a drop before the script's first call
 * that changed the host, so nothing changed there; a later drop is `failure`, except host-run's, which is `dropped` (the
 * engine may be running: resume with `--collect-only`). `waiting` is host-run's `--max-wait` passing with the engine
 * still running; `pending` is host-sync-claude's `--dry-run` finding changes.
 */
export const EXIT = { ok: 0, failure: 1, usage: 2, unreachable: 3, waiting: 4, pending: 10, dropped: 255 };
