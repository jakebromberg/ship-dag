// Tests for mergeSettings and syncClaude (with a fake ssh/rsync runner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSettings, syncClaude } from './host-sync-claude.mjs';

const pre = { matcher: 'Bash', hooks: [{ type: 'command', command: 'pre' }] };
const post = { matcher: 'Bash', hooks: [{ type: 'command', command: 'post' }] };
const other = { matcher: 'Edit', hooks: [{ type: 'command', command: 'mine' }] };
const entry = { hooks: { PreToolUse: [pre], PostToolUse: [post] } };

for (const [name, host, expected] of [
  ['empty settings gain the entries', {}, { hooks: { PreToolUse: [pre], PostToolUse: [post] } }],
  ['host-only keys are kept', { model: 'x', env: { A: '1' } }, { model: 'x', env: { A: '1' }, hooks: { PreToolUse: [pre], PostToolUse: [post] } }],
  ['host hook entries are kept and the new one appended', { hooks: { PreToolUse: [other], Stop: [other] } }, { hooks: { PreToolUse: [other, pre], Stop: [other], PostToolUse: [post] } }],
  ['an entry already present is not added again', { hooks: { PreToolUse: [pre], PostToolUse: [post] } }, { hooks: { PreToolUse: [pre], PostToolUse: [post] } }],
]) {
  test(`mergeSettings: ${name}`, () => {
    assert.deepEqual(mergeSettings(host, entry), expected);
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

test('rsync adds without deleting and skips the ship-dag symlink; a failing step is reported and the rest still run', () => {
  const files = { '/h/.claude/CLAUDE.md': 'GLOBAL\n' };
  const { run } = fakeHost(files);
  const calls = [];
  const failing = (cmd, args, input) => (cmd === 'rsync' ? (calls.push([cmd, ...args]), { status: 23, stdout: '', stderr: 'boom' }) : run(cmd, args, input));
  const { failures } = syncClaude({ ...base, run: failing });
  assert.deepEqual(failures, ['skills: boom']);
  const args = calls.find((c) => c[0] === 'rsync');
  assert.ok(args.includes('--exclude=/ship-dag') && !args.some((a) => a.startsWith('--delete')));
  assert.ok(files['/h/.claude/settings.json']);
});
