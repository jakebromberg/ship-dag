// Tests for the host registry (references/hosts.json) and its validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHosts, validateHosts } from './hosts.mjs';

const GOOD = { ssh: 'box', home: '/Users/jake', reposDir: '/Users/jake/Developer', sdHome: '/Users/jake/Developer/ship-dag' };

test('the shipped hosts.json loads, listing funlandresearch with the node toolchain', () => {
  assert.deepEqual(Object.keys(loadHosts()), ['funlandresearch']);
  assert.deepEqual(loadHosts().funlandresearch.toolchains, ['node']);
});

test('validateHosts accepts a full entry, defaulting toolchains to none', () => {
  const full = { ...GOOD, coHome: '/c', sessionSlots: 2, leaseSlots: 1, toolchains: ['node', 'python'] };
  assert.deepEqual(validateHosts({ a: full, b: GOOD }).a, full);
  assert.deepEqual(validateHosts({ b: GOOD }).b.toolchains, []);
});

for (const [name, coHome, expected] of [
  ['defaults coHome to <home>/Developer/claude-orchestrator', undefined, '/Users/jake/Developer/claude-orchestrator'],
  ['keeps a coHome it is given', '/c', '/c'],
]) {
  test(`validateHosts ${name}`, () => {
    assert.equal(validateHosts({ a: { ...GOOD, coHome } }).a.coHome, expected);
  });
}

for (const [name, hosts, message] of [
  ['an entry missing ssh', { a: { ...GOOD, ssh: undefined } }, /a: ssh must be a non-empty string/],
  ['an entry missing home', { a: { ...GOOD, home: undefined } }, /a: home must be a non-empty string/],
  ['an entry missing reposDir', { a: { ...GOOD, reposDir: '' } }, /a: reposDir must be a non-empty string/],
  ['an entry missing sdHome', { a: { ...GOOD, sdHome: undefined } }, /a: sdHome must be a non-empty string/],
  ['a zero sessionSlots', { a: { ...GOOD, sessionSlots: 0 } }, /a: sessionSlots must be a positive integer/],
  ['a fractional leaseSlots', { a: { ...GOOD, leaseSlots: 1.5 } }, /a: leaseSlots must be a positive integer/],
  ['a string sessionSlots', { a: { ...GOOD, sessionSlots: '2' } }, /a: sessionSlots must be a positive integer/],
  ['an unknown toolchain', { a: { ...GOOD, toolchains: ['rust'] } }, /a: toolchains must be an array of node\/python\/xcode/],
  ['a host named local', { local: GOOD }, /local: is implicit/],
  ['an entry that is not an object', { a: 'box' }, /a: must be an object/],
]) {
  test(`validateHosts rejects ${name}`, () => {
    assert.throws(() => validateHosts(hosts), message);
  });
}
