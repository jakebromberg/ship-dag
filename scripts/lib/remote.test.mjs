// Tests for the shared remote-host plumbing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SSH_OPTS, remoteCommand, shQuote } from './remote.mjs';

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
