import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_CI_COMMAND, ciProfileFor, inWorktree, loadProfiles, repoCiScript, resolveCiProfile } from './ci-profile.mjs';
import { graphqlAnswer, graphqlFailure, restFailure } from './gh-fixture.mjs';

const R = 'o/r';
const EXEC = 0o100755;
const PLAIN = 0o100644;

// The GraphQL answers, as recorded 2026-10-16 with gh 2.102.0: `defaultBranchRef` (and `ref` when a base is named)
// with the commit's `file(path:)` as `{mode, type}` (33261 = 100755, 33188 = 100644, 16384 a tree). A missing file is
// `file: null` plus a NOT_FOUND error whose path ends in `file`, which makes gh exit 1; a missing ref is `ref: null`
// with no error; a missing or unreadable repo is `repository: null` plus a NOT_FOUND error at `["repository"]`.
const at = (file) => ({ target: { file } });
function body({ file = { mode: EXEC, type: 'blob' }, defaultBranch = 'main', ref } = {}) {
  const repository = { defaultBranchRef: defaultBranch === null ? null : { name: defaultBranch, ...at(file) } };
  if (ref !== undefined) repository.ref = ref === null ? null : { name: ref, ...at(file) };
  const errors = file === null ? [{ type: 'NOT_FOUND', path: ['repository', ref === undefined ? 'defaultBranchRef' : 'ref', 'target', 'file'], message: "Could not resolve file for path 'scripts/ci'." }] : undefined;
  return { data: { repository }, ...(errors && { errors }) };
}
const missingRepo = { data: { repository: null }, errors: [{ type: 'NOT_FOUND', path: ['repository'], message: "Could not resolve to a Repository with the name 'o/r'." }] };
const rateLimited = { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 1.' }] };

/** A fake `gh` answering each call from `answers` in order (a GraphQL body goes through graphqlAnswer, an Error is thrown), recording argv. */
function fakeGh(...answers) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return graphqlAnswer(a, args);
  };
  return Object.assign(gh, { calls });
}
/** The value of a `-f k=v` / `-F k=v` field in a gh argv. */
const field = (args, k) => args.find((a, i) => /^-[fF]$/.test(args[i - 1]) && a.startsWith(`${k}=`))?.slice(k.length + 1);
const noSleep = async () => {};
const probe = (answer, base) => repoCiScript(R, base, { gh: fakeGh(answer), sleep: noSleep });

test('REPO_CI_COMMAND is the bare convention, run from the worktree root', () => {
  assert.equal(REPO_CI_COMMAND, 'scripts/ci');
});

for (const [name, profiles, found, expected] of [
  ['a registry entry with commands wins over the repo script', { [R]: { commands: ['npm test'] } }, { hasScript: true }, { baseBranch: 'main', commands: ['npm test'], source: 'registry' }],
  ['a registry entry with commands needs no repo script', { [R]: { commands: ['npm test'] } }, {}, { baseBranch: 'main', commands: ['npm test'], source: 'registry' }],
  ['an entry with empty commands falls through to the repo script', { [R]: { commands: [] } }, { hasScript: true }, { baseBranch: 'main', commands: ['scripts/ci'], source: 'repo' }],
  ['no entry and a repo script runs scripts/ci', {}, { hasScript: true }, { baseBranch: 'main', commands: ['scripts/ci'], source: 'repo' }],
  ['no entry and no repo script has no commands', {}, { hasScript: false }, { baseBranch: 'main', commands: [], source: 'none' }],
  ["no entry takes the repo's default branch", {}, { hasScript: true, defaultBranch: 'master' }, { baseBranch: 'master', commands: ['scripts/ci'], source: 'repo' }],
  ["the registry's baseBranch beats the default branch", { [R]: { baseBranch: 'release/1.x' } }, { hasScript: true, defaultBranch: 'main' }, { baseBranch: 'release/1.x', commands: ['scripts/ci'], source: 'repo' }],
  ["the registry's baseBranch is kept with no commands at all", { [R]: { baseBranch: 'master' } }, { hasScript: false }, { baseBranch: 'master', commands: [], source: 'none' }],
]) {
  test(`resolveCiProfile: ${name}`, () => {
    assert.deepEqual(resolveCiProfile(R, profiles, found), { repo: R, ...expected });
  });
}

for (const [name, answer, base, expected] of [
  ['an executable file on the default branch is present', body(), undefined, { defaultBranch: 'main', hasScript: true }],
  ['a missing file is absent', body({ file: null }), undefined, { defaultBranch: 'main', hasScript: false }],
  ['a directory named scripts/ci is absent', body({ file: { mode: 0o40000, type: 'tree' } }), undefined, { defaultBranch: 'main', hasScript: false }],
  ['a master default branch is read, not assumed', body({ defaultBranch: 'master' }), undefined, { defaultBranch: 'master', hasScript: true }],
  ['a named base reads that branch', body({ ref: 'release/1.x' }), 'release/1.x', { defaultBranch: 'main', hasScript: true }],
  ['a named base with no file is absent', body({ ref: 'release/1.x', file: null }), 'release/1.x', { defaultBranch: 'main', hasScript: false }],
]) {
  test(`repoCiScript: ${name}`, async () => {
    assert.deepEqual(await probe(answer, base), expected);
  });
}

test('repoCiScript: asks one GraphQL query for scripts/ci, naming the base branch only when there is one', async () => {
  const gh = fakeGh(body(), body({ ref: 'release/1.x' }));
  await repoCiScript(R, undefined, { gh, sleep: noSleep });
  await repoCiScript(R, 'release/1.x', { gh, sleep: noSleep });
  const [noBase, withBase] = gh.calls;
  for (const args of gh.calls) {
    assert.deepEqual(args.slice(0, 2), ['api', 'graphql']);
    assert.deepEqual([field(args, 'owner'), field(args, 'name'), field(args, 'path')], ['o', 'r', 'scripts/ci']);
  }
  assert.deepEqual([field(noBase, 'hasBase'), field(withBase, 'hasBase')], ['false', 'true']);
  assert.equal(field(withBase, 'qualified'), 'refs/heads/release/1.x');
});

test('repoCiScript: a rate limit is retried, not fatal', async () => {
  const gh = fakeGh(graphqlFailure(rateLimited), body());
  assert.deepEqual(await repoCiScript(R, undefined, { gh, sleep: noSleep }), { defaultBranch: 'main', hasScript: true });
  assert.equal(gh.calls.length, 2);
});

for (const [name, answer, base, message] of [
  ['a non-executable scripts/ci throws, naming its mode', body({ file: { mode: PLAIN, type: 'blob' } }), undefined, /^Error: o\/r: scripts\/ci on main is not executable \(mode 100644\); commit it with chmod \+x$/],
  ['a symlinked scripts/ci throws, naming its mode', body({ file: { mode: 0o120000, type: 'blob' } }), undefined, /^Error: o\/r: scripts\/ci on main is not executable \(mode 120000\)/],
  ['a missing or unreadable repo throws, never reads as absent', missingRepo, undefined, /^Error: o\/r: repository not found, or this token cannot read it$/],
  ['a named base the repo lacks throws, pointing at the registry', body({ ref: null }), 'master', /^Error: o\/r: base branch master not found; set its baseBranch in references\/repo-ci-profiles\.json$/],
  ['a repo with no default branch throws', body({ defaultBranch: null }), undefined, /^Error: o\/r: has no default branch/],
  ['a server error throws once, naming the repo', restFailure(502, 'Bad Gateway', ['api', 'graphql']), undefined, /^Error: o\/r: could not look up scripts\/ci: Bad Gateway \(HTTP 502\)$/],
]) {
  test(`repoCiScript: ${name}`, async () => {
    await assert.rejects(probe(answer, base), message);
  });
}

test('repoCiScript: an exhausted rate limit names the repo once', async () => {
  const gh = fakeGh(...Array.from({ length: 6 }, () => graphqlFailure(rateLimited)));
  await assert.rejects(repoCiScript(R, undefined, { gh, sleep: noSleep }), (err) => {
    assert.match(err.message, /^o\/r: GitHub rate limit persisted after 5 retries/);
    assert.equal(err.message.split('o/r:').length, 2);
    return true;
  });
});

test('ciProfileFor: a registry entry with commands makes no gh call', async () => {
  const gh = fakeGh();
  assert.deepEqual(await ciProfileFor(R, { profiles: { [R]: { commands: ['x'] } }, gh }), { repo: R, baseBranch: 'main', commands: ['x'], source: 'registry' });
  assert.deepEqual(gh.calls, []);
});

test("ciProfileFor: otherwise reads scripts/ci on the registry's base branch, else the default branch", async () => {
  const gh = fakeGh(body({ ref: 'release/1.x' }), body({ defaultBranch: 'master', file: null }));
  assert.deepEqual(await ciProfileFor(R, { profiles: { [R]: { baseBranch: 'release/1.x' } }, gh, sleep: noSleep }), { repo: R, baseBranch: 'release/1.x', commands: ['scripts/ci'], source: 'repo' });
  assert.deepEqual(await ciProfileFor(R, { profiles: {}, gh, sleep: noSleep }), { repo: R, baseBranch: 'master', commands: [], source: 'none' });
  assert.equal(field(gh.calls[0], 'qualified'), 'refs/heads/release/1.x');
});

test("inWorktree: a repo-declared profile whose worktree lacks scripts/ci has no commands, as step 4 configured none", () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-profile-'));
  try {
    const declared = { repo: R, baseBranch: 'main', commands: ['scripts/ci'], source: 'repo' };
    assert.deepEqual(inWorktree(declared, dir), { ...declared, commands: [], source: 'none' });
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'ci'), '#!/bin/sh\n');
    chmodSync(join(dir, 'scripts', 'ci'), 0o755);
    assert.deepEqual(inWorktree(declared, dir), declared);
    const registry = { repo: R, baseBranch: 'main', commands: ['npm test'], source: 'registry' };
    assert.equal(inWorktree(registry, join(dir, 'gone')), registry);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadProfiles reads the shipped registry', () => {
  assert.ok(loadProfiles()['jakebromberg/code-audit-pipeline']?.commands?.length > 0);
});
