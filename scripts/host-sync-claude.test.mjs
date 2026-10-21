// Tests for the host-sync-claude CLI's argument handling; the sync itself is tested in scripts/lib.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, runner } from './host-sync-claude.mjs';
import { validateHosts } from './lib/hosts.mjs';

// Validated as loadHosts would, so `coHome` is the registry default.
const { box } = validateHosts({ box: { ssh: 'box', home: '/h', reposDir: '/h/D', sdHome: '/h/D/ship-dag' } });

for (const [name, argv, hosts] of [
  ['an unknown flag (a mistyped --dry-run)', ['box', '--dryrun'], { box }],
  ['an unknown flag before the host', ['--dryrun', 'box'], { box }],
  ['a single-dash flag after the host', ['box', '-n'], { box }],
  ['a single-dash flag before the host', ['-n', 'box'], { box }],
  ['an extra positional argument', ['box', 'dry-run'], { box }],
  ['a second host', ['box', 'box'], { box }],
  ['an em-dash flag', ['box', '—dry-run'], { box }],
  ['an en-dash flag', ['box', '–dry-run'], { box }],
  ['no host', ['--dry-run'], { box }],
  ['an unknown host', ['nope'], { box }],
  ['a host name that is only an inherited key', ['constructor'], {}],
]) {
  test(`${name} exits 2 and runs nothing`, () => {
    const calls = [];
    assert.equal(main(argv, { hosts, run: (...c) => (calls.push(c), { status: 0, stdout: '' }) }), 2);
    assert.deepEqual(calls, []);
  });
}

test('a known host with --dry-run is synced as a dry run and exits 0', () => {
  const calls = [];
  const run = (cmd, args) => (calls.push([cmd, ...args]), { status: 0, stdout: args.at(-1)?.includes?.('--print-settings-entry') ? '{}' : '' });
  assert.equal(main(['box', '--dry-run'], { hosts: { box }, run, readFile: () => '', localHome: '/m/.claude' }), 0);
  assert.ok(calls.find((c) => c[0] === 'rsync').includes('-n'));
});

// Exit codes for how a sync ended. `run` answers git, ssh and rsync; a host whose CLAUDE.md already matches and whose
// settings and skills need nothing is `clean`, and `pending` adds an rsync itemization line.
const clean = (cmd, args) => ({ status: 0, stderr: '', stdout: cmd === 'ssh' && /CLAUDE\.md/.test(args.at(-1)) ? 'GLOBAL\n' : args.at(-1).includes('--print-settings-entry') ? '{}' : '' });
const pending = (cmd, args) => ({ ...clean(cmd, args), stdout: cmd === 'rsync' ? '>f+++++++++ a\n' : clean(cmd, args).stdout });
const fails = (props) => () => ({ status: null, stdout: '', stderr: '', ...props });
const sync = (argv, run) => main(argv, { hosts: { box }, run, readFile: () => 'GLOBAL\n', localHome: '/m/.claude' });

for (const [name, argv, run, expected] of [
  ['a sync with nothing to do', ['box'], clean, 0],
  ['a real sync that changed something', ['box'], pending, 0],
  ['an unreachable host (ssh exit 255)', ['box'], fails({ status: 255 }), 3],
  ['an unreachable host in a dry run', ['box', '--dry-run'], fails({ status: 255 }), 3],
  ['an unreachable host that timed out', ['box'], fails({ error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }) }), 3],
  ['a missing ssh', ['box'], fails({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }), 1],
  ['a failing command', ['box'], fails({ status: 1, stderr: 'no' }), 1],
  ['a dry run with changes pending', ['box', '--dry-run'], pending, 10],
  ['a dry run with nothing pending', ['box', '--dry-run'], clean, 0],
  ['a dry run with changes pending and a failed step', ['box', '--dry-run'], (cmd, args) => (cmd === 'rsync' ? { status: 23, stdout: '', stderr: 'boom' } : pending(cmd, args)), 1],
]) {
  test(`${name} exits ${expected}`, () => {
    assert.equal(sync(argv, run), expected);
  });
}

// Every spawned command is bounded, so a hung host fails its step instead of stalling the sync.
for (const cmd of ['ssh', 'rsync', 'git']) {
  test(`the real runner spawns ${cmd} with a timeout and passes its input`, () => {
    let seen;
    runner((c, a, opts) => ((seen = opts), { status: 0, stdout: '' }))(cmd, [], 'in');
    assert.ok(seen.timeout > 0, JSON.stringify(seen));
    assert.equal(seen.input, 'in');
  });
}
