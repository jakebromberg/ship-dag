// Tests for remote.mjs's config-to-host rule; board.test.mjs renders remote tickets end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configHost } from './remote.mjs';

for (const [path, host] of [
  ['/e/run-w9/hosts/config.funland.json', 'funland'],
  ['/e/run-w9/hosts/config.local.json', null],
  ['/e/run-w9/config.json', null],
  ['/e/run-w9/config.funland.json', null],
  ['/e/run-w9/state/config.funland.json', null],
]) {
  test(`configHost: ${path} → ${host}`, () => assert.equal(configHost(path), host));
}
