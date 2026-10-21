// Tests for the shared remote-host plumbing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT, RSYNC_SSH, SSH_MAX_BUFFER, SSH_OPTS, callFailure, remoteCommand, shQuote, sshCommandLine } from './remote.mjs';

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
