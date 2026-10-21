// remote.mjs — the one place that holds how a command runs on a hosts.json host: ssh options, shell quoting and the
// remote shell. host-prepare, host-sync-claude and any later host runner use it instead of carrying their own copy.

// Never prompt for a password or host key, and give up on an unreachable host. Used by every ssh, scp and `rsync -e`.
export const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];

/** `s` (coerced with String()) as one POSIX single-quoted shell word. */
export const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * `cmd`, to run over ssh on a host and find node, gh and claude. It is returned unchanged: over plain non-interactive
 * ssh, `command -v node gh claude` on mini resolves all three to /Users/me/.local/bin, which ~/.zshenv
 * puts on PATH ($SHELL is /bin/zsh; /opt/homebrew/bin exists but holds none of them), checked 2026-10-21. A login
 * shell (`$SHELL -lc`) is not needed there; a host whose .zshenv lacks the PATH would need it added here, once.
 */
export const remoteCommand = (cmd) => cmd;
