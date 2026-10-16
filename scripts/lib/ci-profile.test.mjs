import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPO_CI_COMMAND, ciProfileFor, loadProfiles, repoHasCiScript, resolveCiProfile } from './ci-profile.mjs';
import { restFailure } from './gh-fixture.mjs';

const R = 'o/r';
const contentsArgs = (base = 'main') => ['api', `repos/${R}/contents/scripts/ci?ref=${encodeURIComponent(base)}`];
// The 200 bodies of `gh api repos/<repo>/contents/<path>?ref=<base>`, recorded 2026-10-16 (gh 2.102.0) and cut to
// the fields read: a file is one object with `type: "file"`; a directory is an array of entries.
const FILE = JSON.stringify({ type: 'file', name: 'ci', path: 'scripts/ci', size: 120, sha: 'abc', encoding: 'base64', content: '' });
const DIR = JSON.stringify([{ type: 'file', name: 'lint', path: 'scripts/ci/lint' }]);
// A 404 for a ref the repo does not have, as gh prints it (recorded with the file 404 above).
const noRef = (base) => restFailure(404, `No commit found for the ref ${base}`, contentsArgs(base));

/** A fake `gh` answering each call from `answers` in order (a string is stdout, an Error is thrown), recording argv. */
function fakeGh(...answers) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return a;
  };
  return Object.assign(gh, { calls });
}
const noSleep = async () => {};

test('REPO_CI_COMMAND is the bare convention, run from the worktree root', () => {
  assert.equal(REPO_CI_COMMAND, 'scripts/ci');
});

for (const [name, profiles, hasScript, expected] of [
  ['a registry entry with commands wins over the repo script', { [R]: { commands: ['npm test'] } }, true, { baseBranch: 'main', commands: ['npm test'], source: 'registry' }],
  ['a registry entry with commands needs no repo script', { [R]: { commands: ['npm test'] } }, false, { baseBranch: 'main', commands: ['npm test'], source: 'registry' }],
  ['an entry with empty commands falls through to the repo script', { [R]: { commands: [] } }, true, { baseBranch: 'main', commands: ['scripts/ci'], source: 'repo' }],
  ['no entry and a repo script runs scripts/ci', {}, true, { baseBranch: 'main', commands: ['scripts/ci'], source: 'repo' }],
  ['no entry and no repo script has no commands', {}, false, { baseBranch: 'main', commands: [], source: 'none' }],
  ["the registry's baseBranch is kept when the repo script decides", { [R]: { baseBranch: 'release/1.x' } }, true, { baseBranch: 'release/1.x', commands: ['scripts/ci'], source: 'repo' }],
  ["the registry's baseBranch is kept with no commands at all", { [R]: { baseBranch: 'master' } }, false, { baseBranch: 'master', commands: [], source: 'none' }],
]) {
  test(`resolveCiProfile: ${name}`, () => {
    assert.deepEqual(resolveCiProfile(R, profiles, { hasScript }), { repo: R, ...expected });
  });
}

for (const [name, answer, expected] of [
  ['a file is present', FILE, true],
  ['a directory named scripts/ci is not', DIR, false],
  ['a REST 404 is absent', restFailure(404, 'Not Found', contentsArgs()), false],
]) {
  test(`repoHasCiScript: ${name}`, async () => {
    const gh = fakeGh(answer);
    assert.equal(await repoHasCiScript(R, 'main', { gh, sleep: noSleep }), expected);
    assert.deepEqual(gh.calls, [contentsArgs()]);
  });
}

test('repoHasCiScript: the base branch is encoded into the query', async () => {
  const gh = fakeGh(FILE);
  await repoHasCiScript(R, 'release/1.x#a&b', { gh, sleep: noSleep });
  assert.deepEqual(gh.calls, [['api', `repos/${R}/contents/scripts/ci?ref=release%2F1.x%23a%26b`]]);
});

test('repoHasCiScript: a rate limit is retried, not fatal', async () => {
  const gh = fakeGh(restFailure(403, 'API rate limit exceeded for user ID 1.', contentsArgs()), FILE);
  assert.equal(await repoHasCiScript(R, 'main', { gh, sleep: noSleep }), true);
  assert.equal(gh.calls.length, 2);
});

for (const [name, answer, message] of [
  ['a server error throws, naming the repo, never reads as absent', restFailure(500, 'Server Error', contentsArgs()), /o\/r: could not read scripts\/ci on main: .*Server Error/],
  ['a base branch the repo lacks throws, pointing at the registry', noRef('main'), /o\/r: base branch main not found.*baseBranch.*repo-ci-profiles\.json/],
  ['a body that is not JSON throws', 'not json', /o\/r: could not read scripts\/ci on main/],
]) {
  test(`repoHasCiScript: ${name}`, async () => {
    await assert.rejects(repoHasCiScript(R, 'main', { gh: fakeGh(answer), sleep: noSleep }), message);
  });
}

test('ciProfileFor: a registry entry with commands makes no gh call', async () => {
  const gh = fakeGh();
  assert.deepEqual(await ciProfileFor(R, { profiles: { [R]: { commands: ['x'] } }, gh }), { repo: R, baseBranch: 'main', commands: ['x'], source: 'registry' });
  assert.deepEqual(gh.calls, []);
});

test("ciProfileFor: otherwise asks for scripts/ci on the registry's base branch", async () => {
  const gh = fakeGh(FILE);
  const profile = await ciProfileFor(R, { profiles: { [R]: { baseBranch: 'master' } }, gh, sleep: noSleep });
  assert.deepEqual(profile, { repo: R, baseBranch: 'master', commands: ['scripts/ci'], source: 'repo' });
  assert.deepEqual(gh.calls, [contentsArgs('master')]);
});

test('ciProfileFor: no entry and no script resolves to no commands', async () => {
  const profile = await ciProfileFor(R, { profiles: {}, gh: fakeGh(restFailure(404, 'Not Found', contentsArgs())), sleep: noSleep });
  assert.deepEqual(profile, { repo: R, baseBranch: 'main', commands: [], source: 'none' });
});

test('loadProfiles reads the shipped registry', () => {
  const profiles = loadProfiles();
  assert.ok(profiles['jakebromberg/code-audit-pipeline']?.commands?.length > 0);
});
