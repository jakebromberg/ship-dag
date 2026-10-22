// Tests for the shared remote-host plumbing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT, RSYNC_SSH, SSH_MAX_BUFFER, SSH_OPTS, UsageError, asUsage, callFailure, remoteCommand, runCli, shQuote, sshCommandLine } from './remote.mjs';

for (const [name, input, expected] of [
  ['a plain string', 'abc', "'abc'"],
  ['a string with a single quote', "it's", `'it'\\''s'`],
  ['an empty string', '', "''"],
  ['a number', 42, "'42'"],
]) {
  test(`shQuote quotes ${name}`, () => {
    assert.equal(shQuote(input), expected);
  });
}

test('ssh never prompts and gives up on an unreachable host', () => {
  assert.deepEqual(SSH_OPTS, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']);
});

test('remoteCommand leaves the command as it is', () => {
  assert.equal(remoteCommand('node x'), 'node x');
});

test('the shared ssh and rsync output bound is 16 MiB', () => {
  assert.equal(SSH_MAX_BUFFER, 16_777_216);
});

test('rsync -e runs ssh with the shared options', () => {
  assert.equal(RSYNC_SSH, 'ssh -o BatchMode=yes -o ConnectTimeout=10');
});

test('sshCommandLine prints the ssh options, the quoted alias and the quoted remote command', () => {
  assert.equal(sshCommandLine("o'box", 'npx x --tail'), "ssh -o BatchMode=yes -o ConnectTimeout=10 'o'\\''box' 'npx x --tail'");
});

for (const [name, result, expected] of [
  ['ssh exit 255', { status: 255 }, 'dropped'],
  ['a call that timed out', { status: null, error: { code: 'ETIMEDOUT', message: 'spawnSync ssh ETIMEDOUT' } }, 'dropped'],
  ['an overflowed buffer', { status: null, error: { code: 'ENOBUFS', message: 'spawnSync ssh ENOBUFS' } }, 'spawnSync ssh ENOBUFS'],
  ['a missing binary', { status: null, error: { code: 'ENOENT', message: 'spawnSync rsync ENOENT' } }, 'spawnSync rsync ENOENT'],
  ['an execFileSync error that timed out', Object.assign(new Error('spawnSync ssh ETIMEDOUT'), { code: 'ETIMEDOUT', status: null }), 'dropped'],
  ['an execFileSync error for ssh exit 255', Object.assign(new Error('Command failed: ssh'), { status: 255 }), 'dropped'],
  ['an execFileSync error for a missing binary', Object.assign(new Error('spawnSync ssh ENOENT'), { code: 'ENOENT', status: null }), 'spawnSync ssh ENOENT'],
  ['a normal non-zero status', { status: 1 }, undefined],
  ['status 0', { status: 0 }, undefined],
]) {
  test(`callFailure: ${name}`, () => {
    assert.equal(callFailure(result), expected);
  });
}

test('the exit codes of host-prepare, host-sync-claude and host-run are fixed and distinct', () => {
  assert.deepEqual(EXIT, { ok: 0, failure: 1, usage: 2, unreachable: 3, waiting: 4, pending: 10, dropped: 255 });
  assert.equal(new Set(Object.values(EXIT)).size, Object.keys(EXIT).length);
});

// runCli: main's code, else EXIT.usage for a usage error, else the error's own exitCode, else EXIT.failure; `err` gets the message and a newline.
const carried = Object.assign(new Error('carried'), { exitCode: 3 });
const both = Object.assign(new UsageError('both'), { exitCode: 3 });
for (const [name, main, expected, message] of [
  ['a returned code', () => 10, 10, undefined],
  ['a returned promise of a code', async () => 4, 4, undefined],
  ['a usage error', () => { throw new UsageError('bad flag'); }, 2, 'bad flag'],
  ['a usage error from an async main', async () => { throw new UsageError('bad flag'); }, 2, 'bad flag'],
  ['a carried exitCode', () => { throw carried; }, 3, 'carried'],
  ['a usage error that also carries an exitCode', () => { throw both; }, 2, 'both'],
  ['a plain Error', () => { throw new Error('boom'); }, 1, 'boom'],
  ['a plain Error from an async main', async () => { throw new Error('boom'); }, 1, 'boom'],
]) {
  test(`runCli maps ${name} to ${expected}`, async () => {
    const lines = [];
    assert.equal(await runCli(main, ['a'], { err: (s) => lines.push(s) }), expected);
    assert.deepEqual(lines, message === undefined ? [] : [`${message}\n`]);
  });
}

test('runCli passes argv and its deps (err included) to main', () => {
  const err = () => {};
  let seen;
  runCli((argv, deps) => { seen = [argv, deps]; return 0; }, ['x'], { err, run: 1 });
  assert.deepEqual(seen, [['x'], { err, run: 1 }]);
});

test('asUsage turns a plain error into a usage error and passes a value through', () => {
  assert.equal(asUsage(() => 5), 5);
  assert.throws(() => asUsage(() => { throw new Error('--state requires a value'); }), (e) => e instanceof UsageError && e.message === '--state requires a value');
});
