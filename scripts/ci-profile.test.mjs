// Tests for SKILL.md step 4's per-repo CI lookup CLI. The resolution itself is tested in lib/ci-profile.test.mjs;
// these pin the CLI's output shape and exit codes, with a stub `gh` first on PATH so nothing reaches GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ghStubBin, restFailure } from './lib/gh-fixture.mjs';

const SCRIPT = fileURLToPath(new URL('./ci-profile.mjs', import.meta.url));
const REGISTERED = 'jakebromberg/code-audit-pipeline';
const FILE = JSON.stringify({ type: 'file', name: 'ci', path: 'scripts/ci' });

/** Runs the CLI with a stub gh answering every call with `answer` (stdout, or a failure's stdout/stderr/status). */
function cli(args, answer = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-profile-'));
  try {
    const bin = ghStubBin(dir, typeof answer === 'string' ? { stdout: answer } : answer);
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("prints a repos map ready for the spec's repos, one entry per repo argument", () => {
  const r = cli([REGISTERED, 'o/declared'], FILE);
  assert.equal(r.status, 0, r.stderr);
  const repos = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(repos), [REGISTERED, 'o/declared']);
  assert.equal(repos[REGISTERED].source, 'registry');
  assert.ok(repos[REGISTERED].commands.length > 0);
  assert.deepEqual(repos['o/declared'], { baseBranch: 'main', commands: ['scripts/ci'], source: 'repo' });
});

test('a repo with neither an entry nor scripts/ci prints no commands and exits 0 (emit-config warns)', () => {
  const r = cli(['o/bare'], restFailure(404, 'Not Found'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { 'o/bare': { baseBranch: 'main', commands: [], source: 'none' } });
});

test('a lookup failure exits 1 naming the repo, and prints nothing on stdout', () => {
  const r = cli(['o/flaky'], restFailure(500, 'Server Error'));
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^ci-profile: o\/flaky: could not read scripts\/ci on main: Server Error \(HTTP 500\)/);
});

for (const [name, args] of [['no repo', []], ['a repo that is not owner/repo', ['just-a-name']]]) {
  test(`usage: ${name} exits 64`, () => {
    const r = cli(args);
    assert.equal(r.status, 64);
    assert.match(r.stderr, /usage: ci-profile\.mjs <owner\/repo>/);
  });
}
