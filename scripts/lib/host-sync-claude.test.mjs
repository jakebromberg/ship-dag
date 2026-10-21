// Tests for mergeSettings and syncClaude. The "host" is a temp dir driven by a local `sh -c` in place of ssh; rsync,
// git and the printed lease entry are stubbed, so nothing connects anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeSettings, syncClaude } from './host-sync-claude.mjs';
import { SSH_OPTS as BATCH } from './remote.mjs';

// Lease entries are recognised by their command (it runs `cli-lease.js … hook`), as claude-orchestrator prints them.
const lease = (path, extra = {}) => ({ matcher: 'Bash', hooks: [{ type: 'command', command: `grep -qE 'npm' || exit 0; exec node '${path}/cli-lease.js' hook`, ...extra }] });
const pre = lease('/co/dist/src', { timeout: 500 });
const post = lease('/co/dist/src');
const stalePre = lease('/old/dist/src', { timeout: 450 });
const other = { matcher: 'Edit', hooks: [{ type: 'command', command: 'mine' }] };
const mineBash = { type: 'command', command: 'echo cli-lease.js is mentioned but not run as a hook' };
const entry = { hooks: { PreToolUse: [pre], PostToolUse: [post] } };

for (const [name, host, expected] of [
  ['empty settings gain the entries', {}, { hooks: { PreToolUse: [pre], PostToolUse: [post] } }],
  ['host-only keys are kept', { model: 'x', env: { A: '1' } }, { model: 'x', env: { A: '1' }, hooks: { PreToolUse: [pre], PostToolUse: [post] } }],
  ['host hook entries are kept and the new one appended', { hooks: { PreToolUse: [other], Stop: [other] } }, { hooks: { PreToolUse: [other, pre], Stop: [other], PostToolUse: [post] } }],
  ['an entry already present is not added again', { hooks: { PreToolUse: [pre], PostToolUse: [post] } }, { hooks: { PreToolUse: [pre], PostToolUse: [post] } }],
  ['a stale lease entry is replaced in place, not duplicated', { hooks: { PreToolUse: [other, stalePre, other], PostToolUse: [post] } }, { hooks: { PreToolUse: [other, pre, other], PostToolUse: [post] } }],
  ['a non-lease hook sharing a group with a stale lease hook survives', { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [stalePre.hooks[0], mineBash] }] } }, { hooks: { PreToolUse: [pre, { matcher: 'Bash', hooks: [mineBash] }], PostToolUse: [post] } }],
  ['a lease hook run through the installed claude-orchestrator-lease bin is replaced too', { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'claude-orchestrator-lease hook' }] }] } }, { hooks: { PreToolUse: [pre], PostToolUse: [post] } }],
  ['a stale lease entry on an event no longer printed is removed', { hooks: { PostToolUseFailure: [post], Stop: [other, post] } }, { hooks: { PreToolUse: [pre], PostToolUse: [post], Stop: [other] } }],
]) {
  test(`mergeSettings: ${name}`, () => {
    const merged = mergeSettings(host, entry);
    assert.deepEqual(merged, expected);
    assert.deepEqual(mergeSettings(merged, entry), merged, 'merging the same printed entries again is a no-op');
  });
}

/** A host whose home is a fresh temp dir (with `.claude/` unless `fresh`); `fail(cmd, args)` makes a call fail with 'boom'. */
function shellHost({ fresh = false, fail = () => false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ship-dag-host-sync-'));
  const dir = join(home, '.claude');
  if (!fresh) mkdirSync(dir);
  const calls = [];
  const run = (cmd, args, input) => {
    calls.push([cmd, ...args]);
    if (fail(cmd, args)) return { status: 23, stdout: '', stderr: 'boom' };
    if (cmd === 'git' || cmd === 'rsync') return { status: 0, stdout: '' };
    if (args.at(-1).includes('--print-settings-entry')) return { status: 0, stdout: JSON.stringify(entry) };
    return spawnSync('sh', ['-c', args.at(-1)], { encoding: 'utf8', input });
  };
  return { home, dir, run, calls, host: { ssh: 'box', home, coHome: `${home}/Developer/claude-orchestrator` } };
}
const base = { readFile: () => 'GLOBAL\n', localHome: '/m/.claude', now: () => new Date('2026-10-21T12:00:00Z') };
const read = (f) => readFileSync(f, 'utf8');
const sshCmds = (calls) => calls.filter((c) => c[0] === 'ssh').map((c) => c.at(-1));

test('a sync writes CLAUDE.md with a backup, merges settings, and a second run changes nothing', () => {
  const { dir, run, host } = shellHost();
  writeFileSync(join(dir, 'CLAUDE.md'), 'old\n');
  writeFileSync(join(dir, 'settings.json'), '{"model":"x"}');
  const first = syncClaude({ ...base, host, run });
  assert.deepEqual(first.failures, []);
  assert.equal(read(join(dir, 'CLAUDE.md')), 'GLOBAL\n');
  assert.equal(read(join(dir, 'CLAUDE.md.bak-20261021T120000000Z')), 'old\n');
  assert.deepEqual(JSON.parse(read(join(dir, 'settings.json'))), { model: 'x', ...entry });
  assert.equal(first.changes.length, 2);
  assert.deepEqual(syncClaude({ ...base, host, run }).changes, []);
});

test('a fresh host without ~/.claude gets CLAUDE.md and settings.json', () => {
  const { dir, run, host } = shellHost({ fresh: true });
  assert.deepEqual(syncClaude({ ...base, host, run }).failures, []);
  assert.equal(read(join(dir, 'CLAUDE.md')), 'GLOBAL\n');
  assert.deepEqual(JSON.parse(read(join(dir, 'settings.json'))), entry);
});

test('--dry-run reports the changes and writes nothing', () => {
  const { dir, run, calls, host } = shellHost();
  writeFileSync(join(dir, 'CLAUDE.md'), 'old\n');
  const { changes } = syncClaude({ ...base, host, run, dryRun: true });
  assert.equal(changes.length, 2);
  assert.equal(read(join(dir, 'CLAUDE.md')), 'old\n');
  assert.ok(!existsSync(join(dir, 'settings.json')));
  assert.ok(!sshCmds(calls).some((c) => /cat >|cp /.test(c)));
  assert.ok(calls.find((c) => c[0] === 'rsync').includes('-n'));
});

for (const [file, old] of [['CLAUDE.md', 'old\n'], ['settings.json', '{"model":"x"}']]) {
  // A read error must fail the step, not look like a missing file that is then overwritten.
  test(`an unreadable host ${file} fails its step and is left as it was`, () => {
    const { dir, run, host } = shellHost();
    writeFileSync(join(dir, file), old);
    chmodSync(join(dir, file), 0o000);
    const { failures } = syncClaude({ ...base, host, run });
    chmodSync(join(dir, file), 0o600);
    assert.equal(failures.length, 1);
    assert.ok(failures[0].startsWith(`${file}: `), failures[0]);
    assert.equal(read(join(dir, file)), old);
  });

  test(`a symlinked host ${file} stays a symlink and keeps its mode`, () => {
    const { home, dir, run, host } = shellHost();
    const target = join(home, `dotfiles-${file}`);
    writeFileSync(target, old, { mode: 0o600 });
    symlinkSync(target, join(dir, file));
    assert.deepEqual(syncClaude({ ...base, host, run }).failures, []);
    assert.ok(lstatSync(join(dir, file)).isSymbolicLink());
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.notEqual(read(target), old);
  });
}

test('rsync adds without deleting and skips the ship-dag symlink, the synced/ folder Claude Code manages, .trash, .DS_Store and every skill the host links', () => {
  const { home, dir, run, calls, host } = shellHost();
  mkdirSync(join(dir, 'skills', 'copied'), { recursive: true });
  mkdirSync(join(home, 'checkout'));
  symlinkSync(join(home, 'checkout'), join(dir, 'skills', 'linked'));
  syncClaude({ ...base, host, run });
  const args = calls.find((c) => c[0] === 'rsync');
  for (const ex of ['--exclude=/ship-dag', '--exclude=/synced', '--exclude=/.trash', '--exclude=.DS_Store', '--exclude=/linked']) assert.ok(args.includes(ex), ex);
  assert.ok(!args.includes('--exclude=/copied'));
  assert.ok(!args.some((a) => a.startsWith('--delete')));
  assert.equal(args[args.indexOf('-e') + 1], `ssh ${BATCH.join(' ')}`, 'rsync connects without prompting and with a connect timeout');
});

test('every ssh call runs without prompting and with a connect timeout', () => {
  const { run, calls, host } = shellHost();
  syncClaude({ ...base, host, run });
  const ssh = calls.filter((c) => c[0] === 'ssh');
  assert.ok(ssh.length >= 3);
  for (const c of ssh) assert.deepEqual(c.slice(1, 6), [...BATCH, 'box'], c.join(' '));
});

test('a failed write leaves the host file as it was and no .tmp behind', () => {
  const { dir, run, host } = shellHost();
  writeFileSync(join(dir, 'CLAUDE.md'), 'old\n');
  chmodSync(join(dir, 'CLAUDE.md'), 0o400);
  const { failures } = syncClaude({ ...base, host, run });
  chmodSync(join(dir, 'CLAUDE.md'), 0o600);
  assert.equal(failures.length, 1);
  assert.ok(failures[0].startsWith('CLAUDE.md: '), failures[0]);
  assert.equal(read(join(dir, 'CLAUDE.md')), 'old\n');
  assert.ok(!existsSync(join(dir, 'CLAUDE.md.tmp')));
});

test('the .tmp staging file is readable by its owner only, and a new host file keeps the default mode', () => {
  const { dir, run, host } = shellHost({ fresh: true });
  // Drop the cleanup so the staging file can be inspected.
  const keepTmp = (cmd, args, input) => run(cmd, [...args.slice(0, -1), args.at(-1).replace(/; s=\$\?; rm -f .*$/, '')], input);
  assert.deepEqual(syncClaude({ ...base, host, run: keepTmp }).failures, []);
  assert.equal(statSync(join(dir, 'CLAUDE.md.tmp')).mode & 0o777, 0o600);
  assert.equal(read(join(dir, 'CLAUDE.md')), 'GLOBAL\n');
  assert.equal(statSync(join(dir, 'CLAUDE.md')).mode & 0o777, 0o666 & ~process.umask());
});

for (const [name, porcelain, warns] of [['a dirty synced path warns', ' M CLAUDE.md\n', true], ['a clean synced path does not warn', '', false]]) {
  test(`uncommitted changes: ${name}, and only the synced paths are checked`, () => {
    const logs = [];
    const calls = [];
    const run = (cmd, args) => (calls.push([cmd, ...args]), { status: 0, stdout: cmd === 'git' ? porcelain : cmd === 'ssh' && args.at(-1).includes('--print-settings-entry') ? '{}' : '' });
    syncClaude({ ...base, host: { ssh: 'box', home: '/h', coHome: '/h/Developer/claude-orchestrator' }, run, log: (m) => logs.push(m) });
    assert.deepEqual(calls.find((c) => c[0] === 'git'), ['git', '-C', '/m/.claude', 'status', '--porcelain', '--', 'CLAUDE.md', 'skills']);
    assert.equal(logs.some((l) => l.startsWith('warning: ')), warns);
  });
}

test('the lease entries are printed on the host by a bare node run from its coHome', () => {
  const calls = [];
  const run = (cmd, args) => (calls.push([cmd, ...args]), { status: 0, stdout: cmd === 'ssh' && args.at(-1).includes('--print-settings-entry') ? '{}' : '' });
  syncClaude({ ...base, host: { ssh: 'box', home: '/h', coHome: '/co' }, run });
  const print = sshCmds(calls).find((c) => c.includes('--print-settings-entry'));
  assert.equal(print, `node '/co/dist/src/cli-lease.js' hook --print-settings-entry`);
});

test('a command that cannot be started is reported per step with its error, without throwing', () => {
  const run = () => ({ status: null, stdout: undefined, stderr: undefined, error: new Error('spawn ssh ENOENT') });
  const { failures } = syncClaude({ ...base, host: { ssh: 'box', home: '/h', coHome: '/h/Developer/claude-orchestrator' }, run });
  assert.equal(failures.length, 3);
  assert.ok(failures.every((f) => f.endsWith('spawn ssh ENOENT')), failures.join('\n'));
});

// Each step fails in turn; the steps after it must still run.
for (const [name, fails] of [
  ['CLAUDE.md', (cmd, args) => cmd === 'ssh' && args.at(-1).includes('/.claude/CLAUDE.md')],
  ['settings.json', (cmd, args) => cmd === 'ssh' && args.at(-1).includes('--print-settings-entry')],
  ['skills', (cmd) => cmd === 'rsync'],
]) {
  test(`a failing ${name} step is reported and the other steps still run`, () => {
    const { dir, run, calls, host } = shellHost({ fail: fails });
    writeFileSync(join(dir, 'CLAUDE.md'), 'old\n');
    const { failures } = syncClaude({ ...base, host, run });
    assert.equal(failures.length, 1);
    assert.ok(failures[0].startsWith(`${name}: `) && failures[0].endsWith('boom'), failures[0]);
    assert.equal(name === 'CLAUDE.md' || read(join(dir, 'CLAUDE.md')) === 'GLOBAL\n', true, 'CLAUDE.md written');
    assert.equal(name === 'settings.json' || existsSync(join(dir, 'settings.json')), true, 'settings.json written');
    assert.ok(calls.some((c) => c[0] === 'rsync'), 'rsync ran');
  });
}
