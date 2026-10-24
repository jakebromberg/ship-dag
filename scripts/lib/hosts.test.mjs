// Tests for the host registry (hosts.json, kept outside the repo; see hostsPath) and its validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostsPath, loadHosts, validateHosts } from './hosts.mjs';

const GOOD = { ssh: 'box', home: '/Users/me', reposDir: '/Users/me/Developer', sdHome: '/Users/me/Developer/ship-dag' };

for (const [name, env, expected] of [
  ['SHIP_DAG_HOSTS names the file outright', { SHIP_DAG_HOSTS: '/x/h.json', XDG_CONFIG_HOME: '/xdg' }, '/x/h.json'],
  ['XDG_CONFIG_HOME holds ship-dag/hosts.json', { XDG_CONFIG_HOME: '/xdg' }, '/xdg/ship-dag/hosts.json'],
  ['the default is ~/.config/ship-dag/hosts.json', {}, '/home/me/.config/ship-dag/hosts.json'],
  ['an empty SHIP_DAG_HOSTS or XDG_CONFIG_HOME is unset', { SHIP_DAG_HOSTS: '', XDG_CONFIG_HOME: '' }, '/home/me/.config/ship-dag/hosts.json'],
]) {
  test(`hostsPath: ${name}`, () => {
    assert.equal(hostsPath(env, '/home/me'), expected);
  });
}

test('loadHosts reads a missing registry as no remote hosts', () => {
  assert.deepEqual(loadHosts(join(mkdtempSync(join(tmpdir(), 'hosts-')), 'hosts.json')), {});
});

test('loadHosts validates the registry it reads', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'hosts-')), 'hosts.json');
  writeFileSync(path, JSON.stringify({ hosts: { box: { ...GOOD, toolchains: ['rust'] } } }));
  assert.throws(() => loadHosts(path), /box: toolchains must be an array/);
});

test('the shipped hosts.example.json is a valid registry', () => {
  assert.deepEqual(loadHosts(new URL('../../references/hosts.example.json', import.meta.url)).mini.toolchains, ['node', 'xcode']);
});

test('validateHosts accepts a full entry, defaulting toolchains to none and coHome under home', () => {
  const full = { ...GOOD, coHome: '/c', sessionSlots: 2, leaseSlots: 1, toolchains: ['node', 'python'] };
  assert.deepEqual(validateHosts({ a: full, b: GOOD }), { a: full, b: { ...GOOD, coHome: '/Users/me/Developer/claude-orchestrator', toolchains: [] } });
});

// The default row uses a home other than this Mac's, so it shows coHome is derived from `home`, not a fixed path.
for (const [name, home, coHome, expected] of [
  ['defaults coHome to <home>/Developer/claude-orchestrator', '/h', undefined, '/h/Developer/claude-orchestrator'],
  ['keeps a coHome it is given', '/h', '/c', '/c'],
]) {
  test(`validateHosts ${name}`, () => {
    assert.equal(validateHosts({ a: { ...GOOD, home, coHome } }).a.coHome, expected);
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
