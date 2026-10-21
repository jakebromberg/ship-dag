// Tests for mergeSettings and syncClaude (with a fake ssh/rsync runner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSettings, syncClaude } from './host-sync-claude.mjs';

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

function fakeHost(files) {
  const calls = [];
  const run = (cmd, args, input) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git') return { status: 0, stdout: '' };
    if (cmd === 'rsync') return { status: 0, stdout: files.skills ?? '' };
    const c = args[1];
    if (c.startsWith('cat >')) files[c.match(/mv '[^']+' '([^']+)'/)[1]] = input;
    else if (c.startsWith('cat ')) return { status: 0, stdout: files[c.match(/cat '([^']+)'/)[1]] ?? '' };
    else if (c.startsWith('node ')) return { status: 0, stdout: JSON.stringify(entry) };
    else if (c.startsWith('cp ')) { const [, from, to] = c.match(/cp '([^']+)' '([^']+)'/); files[to] = files[from]; }
    return { status: 0, stdout: '' };
  };
  return { run, calls };
}
const base = { host: { ssh: 'box', home: '/h' }, readFile: () => 'GLOBAL\n', localHome: '/m/.claude', now: () => new Date('2026-10-21T12:00:00Z') };

test('a sync writes CLAUDE.md with a backup, merges settings, and a second run changes nothing', () => {
  const files = { '/h/.claude/CLAUDE.md': 'old\n', '/h/.claude/settings.json': '{"model":"x"}' };
  const { run } = fakeHost(files);
  const first = syncClaude({ ...base, run });
  assert.deepEqual(first.failures, []);
  assert.equal(files['/h/.claude/CLAUDE.md'], 'GLOBAL\n');
  assert.equal(files['/h/.claude/CLAUDE.md.bak-20261021T120000000Z'], 'old\n');
  assert.equal(JSON.parse(files['/h/.claude/settings.json']).model, 'x');
  assert.equal(first.changes.length, 2);
  assert.deepEqual(syncClaude({ ...base, run }).changes, []);
});

test('--dry-run reports the changes and writes nothing', () => {
  const files = { '/h/.claude/CLAUDE.md': 'old\n' };
  const { run, calls } = fakeHost(files);
  const { changes } = syncClaude({ ...base, run, dryRun: true });
  assert.equal(changes.length, 2);
  assert.equal(files['/h/.claude/CLAUDE.md'], 'old\n');
  assert.ok(!calls.some((c) => c[0] === 'ssh' && /^(cat >|cp )/.test(c[2])));
  assert.ok(calls.find((c) => c[0] === 'rsync').includes('-n'));
});

test('rsync adds without deleting and skips the ship-dag symlink', () => {
  const { run, calls } = fakeHost({});
  syncClaude({ ...base, run });
  const args = calls.find((c) => c[0] === 'rsync');
  assert.ok(args.includes('--exclude=/ship-dag') && !args.some((a) => a.startsWith('--delete')));
});

// Each step fails in turn; the steps after it must still run.
for (const [name, fails, failure] of [
  ['CLAUDE.md', (cmd, args) => cmd === 'ssh' && args[1].startsWith("cat '/h/.claude/CLAUDE.md'"), 'CLAUDE.md: '],
  ['settings.json', (cmd, args) => cmd === 'ssh' && args[1].startsWith('node '), 'settings.json: '],
  ['skills', (cmd) => cmd === 'rsync', 'skills: boom'],
]) {
  test(`a failing ${name} step is reported and the other steps still run`, () => {
    const files = { '/h/.claude/CLAUDE.md': 'old\n' };
    const { run, calls } = fakeHost(files);
    const failing = (cmd, args, input) => (fails(cmd, args) ? (calls.push([cmd, ...args]), { status: 23, stdout: '', stderr: 'boom' }) : run(cmd, args, input));
    const { failures } = syncClaude({ ...base, run: failing });
    assert.equal(failures.length, 1);
    assert.ok(failures[0].startsWith(failure) && failures[0].endsWith('boom'), failures[0]);
    assert.equal(name === 'CLAUDE.md' || files['/h/.claude/CLAUDE.md'] === 'GLOBAL\n', true, 'CLAUDE.md written');
    assert.equal(name === 'settings.json' || Boolean(files['/h/.claude/settings.json']), true, 'settings.json written');
    assert.ok(calls.some((c) => c[0] === 'rsync'), 'rsync ran');
  });
}
