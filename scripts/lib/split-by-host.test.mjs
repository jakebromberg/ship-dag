// Tests for splitByHost and the toolchain guard. The emit-config end of the split is in emit-config.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitByHost, toolchainsNeeded } from './split-by-host.mjs';
import { testHost } from './host-fixture.mjs';

for (const [commands, expected] of [
  [['npm ci', 'npx tsc --noEmit', 'node --test'], { toolchains: ['node'], unrecognized: [] }],
  [['uv sync --frozen', 'uv run --no-sync pytest -q', '.venv/bin/ruff check .', 'python3 -m mypy .'], { toolchains: ['python'], unrecognized: [] }],
  [['xcodebuild test -scheme A', 'swift build', 'swift test', 'xcrun simctl list'], { toolchains: ['xcode'], unrecognized: [] }],
  [['cd web && npm test', 'pytest'], { toolchains: ['node', 'python'], unrecognized: [] }],
  [['scripts/ci'], { toolchains: [], unrecognized: ['scripts/ci'] }],
  [['npm test', 'make check'], { toolchains: ['node'], unrecognized: ['make check'] }],
  [[], { toolchains: [], unrecognized: [] }],
]) {
  test(`toolchainsNeeded infers ${JSON.stringify(commands)}`, () => {
    assert.deepEqual(toolchainsNeeded({ commands }), expected);
  });
}

test('declared toolchains win over the commands', () => {
  assert.deepEqual(toolchainsNeeded({ commands: ['scripts/ci'], toolchains: ['python'] }), { toolchains: ['python'], unrecognized: [] });
});

const hosts = { box: testHost('/h', { toolchains: ['node'] }) };
const base = { stateDir: '/s/ship-dag/engine/run1', projectRoot: '/p', promptTemplate: '/sd/scripts/engine/prompt.md', repo: 'o/r' };

test('a spec with no host fields stays one local sub-spec with every issue', () => {
  const spec = { ...base, issues: [{ number: 1 }, { number: 2 }] };
  assert.deepEqual(splitByHost(spec, hosts), { local: spec });
});

test('an issue on a remote host takes the host paths; its siblings stay local with the original paths', () => {
  const spec = { ...base, repos: { 'o/r': { commands: ['npm test'] } }, issues: [{ number: 1, host: 'box' }, { number: 2, repo: 'o/other' }] };
  const split = splitByHost(spec, hosts);
  assert.deepEqual(Object.keys(split), ['box', 'local']);
  assert.deepEqual(split.local, { ...spec, issues: [spec.issues[1]] });
  assert.equal(split.box.stateDir, '/h/.local/state/ship-dag/engine/run1');
  assert.equal(split.box.projectRoot, '/h/D');
  assert.equal(split.box.promptTemplate, '/h/sd/scripts/engine/prompt.md');
  assert.deepEqual(split.box.issues, [spec.issues[0]]);
});

test('a stateDir without the ship-dag/engine/<runId> tail cannot be placed on a remote host', () => {
  const spec = { ...base, stateDir: '/somewhere/else', issues: [{ number: 1, host: 'box' }] };
  assert.throws(() => splitByHost(spec, hosts), /stateDir \/somewhere\/else .*ship-dag\/engine\/<runId>/);
});
