// Tests for the host-sync-claude CLI's argument handling; the sync itself is tested in scripts/lib.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, runner } from './host-sync-claude.mjs';

const box = { ssh: 'box', home: '/h', coHome: '/h/Developer/claude-orchestrator' };

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

// Every spawned command is bounded, so a hung host fails its step instead of stalling the sync.
for (const cmd of ['ssh', 'rsync', 'git']) {
  test(`the real runner spawns ${cmd} with a timeout and passes its input`, () => {
    let seen;
    runner((c, a, opts) => ((seen = opts), { status: 0, stdout: '' }))(cmd, [], 'in');
    assert.ok(seen.timeout > 0, JSON.stringify(seen));
    assert.equal(seen.input, 'in');
  });
}
