import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { filterSpec } from './wave-spec.mjs';
import { buildConfig } from '../emit-config.mjs';

const spec = () => ({
  name: 'ship-dag-sd-1', repo: 'o/a', stateDir: '/s/sd-1', wave: 14, projectRoot: '/p', promptTemplate: '/t.md',
  repos: { 'o/a': { baseBranch: 'main', commands: ['a'] }, 'o/b': { baseBranch: 'dev', commands: ['b'] } },
  issues: [{ number: 1, title: 'one', ref: 'o/a#1' }, { number: 2, repo: 'o/b', title: 'two', ref: 'o/b#2' }, { number: 3, title: 'three' }],
});

// Only the stopped refs may reach the filtered config: the engine relaunches every non-succeeded row it is handed, into its existing branch.
for (const [name, refs, want] of [
  ['one cross-repo ref', ['o/b#2'], ['o/b#2']],
  ['two refs, in the spec\'s order', ['o/a#3', 'o/a#1'], ['o/a#1', 'o/a#3']],
  ['a ref the issue carries only as repo + number', ['o/a#3'], ['o/a#3']],
]) {
  test(`filterSpec: ${name}`, () => {
    const out = filterSpec(spec(), refs);
    assert.deepEqual(out.issues.map((i) => `${i.repo ?? 'o/a'}#${i.number}`), want);
    assert.deepEqual(Object.keys(buildConfig(out).repos).sort(), [...new Set(want.map((r) => r.split('#')[0]))].sort());
  });
}

test('filterSpec: overrides the wave label and state dir, leaving the input spec alone', () => {
  const input = spec();
  const out = filterSpec(input, ['o/a#1'], { wave: '14b', stateDir: '/s/sd-1-w14b' });
  assert.deepEqual([out.wave, out.stateDir, out.name], ['14b', '/s/sd-1-w14b', 'ship-dag-sd-1']);
  assert.deepEqual(input, spec());
});

test('filterSpec: a ref the spec does not hold throws, naming it', () => {
  assert.throws(() => filterSpec(spec(), ['o/a#1', 'o/a#9']), /o\/a#9/);
});

test('wave-spec CLI: prints the filtered spec', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./wave-spec.mjs', import.meta.url)), '-', '--wave', '14b', 'o/b#2'], { input: JSON.stringify(spec()), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.wave, out.issues.map((i) => i.number)], ['14b', [2]]);
});
