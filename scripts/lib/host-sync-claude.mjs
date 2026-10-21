// host-sync-claude.mjs — make a remote host's ~/.claude carry this machine's CLAUDE.md, lease hook entries and skills.
// Never touches projects/, sessions/, history.jsonl, file-history/ or credentials. `run(cmd, args, input)` is injected
// and returns { status, stdout, stderr }, so the steps are testable without ssh.
import { coHome, coDistPathIn } from './co-home.mjs';

const q = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

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

/** Sync `host` ({ ssh, home, coHome? }); returns { changes, failures }, both lists of strings. Changes nothing when `dryRun`. */
export function syncClaude({ host, run, readFile, localHome, dryRun = false, now = () => new Date(), log = () => {} }) {
  const dir = `${host.home}/.claude`;
  const changes = [];
  const failures = [];
  const ssh = (cmd, input) => {
    const r = run('ssh', [host.ssh, cmd], input);
    if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}`);
    return r.stdout;
  };
  const put = (file, text) => ssh(`cat > ${q(`${file}.tmp`)} && mv ${q(`${file}.tmp`)} ${q(file)}`, text);
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

  if (run('git', ['-C', localHome, 'status', '--porcelain']).stdout.trim()) log(`warning: ${localHome} has uncommitted changes; syncing the working tree`);

  step('CLAUDE.md', () => {
    const file = `${dir}/CLAUDE.md`;
    const text = readFile(`${localHome}/CLAUDE.md`);
    const hostText = ssh(`cat ${q(file)} 2>/dev/null; true`);
    if (hostText === text) return;
    const backup = `${file}.bak-${now().toISOString().replace(/[-:.]/g, '')}`;
    change(`copy CLAUDE.md${hostText ? ` (backup ${backup})` : ''}`);
    if (dryRun) return;
    if (hostText) ssh(`cp ${q(file)} ${q(backup)}`);
    put(file, text);
  });

  step('settings.json', () => {
    const file = `${dir}/settings.json`;
    const raw = ssh(`cat ${q(file)} 2>/dev/null; true`);
    const current = raw.trim() ? JSON.parse(raw) : {};
    const entryScript = coDistPathIn(host.coHome ?? coHome({}), 'cli-lease.js');
    const merged = mergeSettings(current, JSON.parse(ssh(`node ${q(entryScript)} hook --print-settings-entry`)));
    if (JSON.stringify(merged) === JSON.stringify(current)) return;
    change('merge lease hook entries into settings.json');
    if (!dryRun) put(file, `${JSON.stringify(merged, null, 2)}\n`);
  });

  step('skills', () => {
    const args = ['-aL', '--itemize-changes', '--exclude=/ship-dag', ...(dryRun ? ['-n'] : []), `${localHome}/skills/`, `${host.ssh}:${dir}/skills/`];
    const r = run('rsync', args);
    if (r.status !== 0) throw new Error(r.stderr);
    for (const line of r.stdout.split('\n').filter((l) => l.trim())) change(`skills: ${line}`);
  });

  return { changes, failures };
}
