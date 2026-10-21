// host-sync-claude.mjs — make a remote host's ~/.claude carry this machine's CLAUDE.md, lease hook entries and skills.
// Never touches projects/, sessions/, history.jsonl, file-history/ or credentials. `run(cmd, args, input)` is injected
// and returns { status, stdout, stderr }, so the steps are testable without ssh.
import { coDistPathIn } from './co-home.mjs';
import { SSH_OPTS, remoteCommand, shQuote as q } from './remote.mjs';

// A lease hook runs `node '<…>/cli-lease.js' hook` (claude-orchestrator's `hook --print-settings-entry` output) or the
// installed `claude-orchestrator-lease hook`.
const isLeaseHook = (h) => /cli-lease\.js'?\s+hook\b|claude-orchestrator-lease\s+hook\b/.test(h?.command ?? '');

/**
 * `hostSettings` with its lease hooks replaced by `entry.hooks` (the freshly printed lease entries). On each event the
 * printed entries take the place of the first group that held a lease hook (else they are appended), and lease hooks on
 * events no longer printed are dropped. Every non-lease hook, group and other key is kept.
 */
export function mergeSettings(hostSettings, entry) {
  if (!entry.hooks) return hostSettings;
  const hooks = { ...hostSettings.hooks };
  for (const event of new Set([...Object.keys(hooks), ...Object.keys(entry.hooks)])) {
    const kept = [];
    let at = -1;
    for (const group of hooks[event] ?? []) {
      const rest = (group.hooks ?? []).filter((h) => !isLeaseHook(h));
      if (rest.length === (group.hooks ?? []).length) kept.push(group);
      else {
        if (at < 0) at = kept.length;
        if (rest.length) kept.push({ ...group, hooks: rest });
      }
    }
    kept.splice(at < 0 ? kept.length : at, 0, ...(entry.hooks[event] ?? []));
    if (kept.length || entry.hooks[event]) hooks[event] = kept;
    else delete hooks[event];
  }
  return { ...hostSettings, hooks };
}

/** Sync `host` (a validated hosts.json entry: { ssh, home, coHome, … }); returns { changes, failures }, both lists of strings. Changes nothing when `dryRun`. */
export function syncClaude({ host, run, readFile, localHome, dryRun = false, now = () => new Date(), log = () => {} }) {
  const dir = `${host.home}/.claude`;
  const changes = [];
  const failures = [];
  const ssh = (cmd, input) => {
    const r = run('ssh', [...SSH_OPTS, host.ssh, cmd], input);
    if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr || r.error?.message}`);
    return r.stdout;
  };
  // '' only when the file is absent; any read error (permissions, a dangling symlink) fails the step.
  const get = (file) => ssh(`if [ -e ${q(file)} ] || [ -L ${q(file)} ]; then cat ${q(file)}; fi`);
  // Written through the existing file, so a symlink stays a symlink and the file keeps its mode. The staging copy is
  // owner-only and removed whether or not the write succeeded.
  const put = (file, text) => {
    const tmp = q(`${file}.tmp`);
    ssh(`mkdir -p ${q(dir)} && (umask 077 && cat > ${tmp}) && cat ${tmp} > ${q(file)}; s=$?; rm -f ${tmp}; exit $s`, text);
  };
  const step = (name, fn) => {
    try {
      fn();
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
      log(`FAILED ${name}: ${err.message}`);
    }
  };
  const change = (msg) => {
    changes.push(msg);
    log(`${dryRun ? 'would ' : ''}${msg}`);
  };

  // Only the paths copied from here: the local settings.json is not read, and projects/ is always dirty.
  const synced = ['CLAUDE.md', 'skills'];
  if (run('git', ['-C', localHome, 'status', '--porcelain', '--', ...synced]).stdout?.trim()) log(`warning: ${localHome} has uncommitted changes in ${synced.join(' or ')}; syncing the working tree`);

  step('CLAUDE.md', () => {
    const file = `${dir}/CLAUDE.md`;
    const text = readFile(`${localHome}/CLAUDE.md`);
    const hostText = get(file);
    if (hostText === text) return;
    const backup = `${file}.bak-${now().toISOString().replace(/[-:.]/g, '')}`;
    change(`copy CLAUDE.md${hostText ? ` (backup ${backup})` : ''}`);
    if (dryRun) return;
    if (hostText) ssh(`cp ${q(file)} ${q(backup)}`);
    put(file, text);
  });

  step('settings.json', () => {
    const file = `${dir}/settings.json`;
    const raw = get(file);
    const current = raw.trim() ? JSON.parse(raw) : {};
    const entryScript = coDistPathIn(host.coHome, 'cli-lease.js');
    const printed = ssh(remoteCommand(`node ${q(entryScript)} hook --print-settings-entry`));
    const merged = mergeSettings(current, JSON.parse(printed));
    if (JSON.stringify(merged) === JSON.stringify(current)) return;
    change('merge lease hook entries into settings.json');
    if (!dryRun) put(file, `${JSON.stringify(merged, null, 2)}\n`);
  });

  step('skills', () => {
    // A skill the host links (as ship-dag is) is the host's own: rsync would replace the link with a copy.
    const skills = `${dir}/skills`;
    const linked = ssh(`if [ -d ${q(skills)} ]; then cd ${q(skills)} && find . -mindepth 1 -maxdepth 1 -type l; fi`)
      .split('\n').filter(Boolean).map((l) => `--exclude=/${l.replace(/^\.\//, '')}`);
    // synced/ belongs to Claude Code's claude.ai skill sync on each machine, manifest and markers included.
    const excludes = ['--exclude=/ship-dag', '--exclude=/synced', '--exclude=/.trash', '--exclude=.DS_Store', ...linked];
    const args = ['-aL', '--itemize-changes', '-e', `ssh ${SSH_OPTS.join(' ')}`, ...excludes, ...(dryRun ? ['-n'] : []), `${localHome}/skills/`, `${host.ssh}:${skills}/`];
    const r = run('rsync', args);
    if (r.status !== 0) throw new Error(r.stderr || r.error?.message);
    for (const line of r.stdout.split('\n').filter((l) => l.trim())) change(`skills: ${line}`);
  });

  return { changes, failures };
}
