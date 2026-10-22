// Tests for the host-prepare CLI core against a fake runner: no test opens a connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildConfigsByHost } from './emit-config.mjs';
import { CLONE_TIMEOUT_MS, cli, layoutReposDir, prepareHost } from './host-prepare.mjs';
import { testHost } from './lib/host-fixture.mjs';

const hosts = { box: testHost('/h', { toolchains: ['node'] }) };
// The config emit-config --by-host writes for box, whose state dir is box's ~/.local/state/ship-dag/engine/run1.
const [{ config: boxConfig }] = buildConfigsByHost({
  name: 'ship-dag-run1', repo: 'o/app', stateDir: '/m/.local/state/ship-dag/engine/run1', projectRoot: '/m/D', promptTemplate: '/m/p.md',
  repos: { 'o/app': { baseBranch: 'main', commands: ['npm test'], host: 'box' }, 'o/lib': { baseBranch: 'main', commands: ['npm test'], host: 'box' } },
  issues: [{ number: 1, title: 'one' }, { number: 2, repo: 'o/lib', title: 'two' }],
}, hosts);
const hostState = '/h/.local/state/ship-dag/engine/run1';
const dir = mkdtempSync(join(tmpdir(), 'host-prepare-'));
const configPath = join(dir, 'config.box.json');
const body = JSON.stringify(boxConfig);
writeFileSync(configPath, body);
const configHash = createHash('sha256').update(body).digest('hex');
const local = { sdSha: 'a', coSha: 'b', claudeHash: 'c' };
const state = (over = {}) => ({ sdSha: 'a', coSha: 'b', distNewest: '/co/dist/src/index.js', srcNewer: '', claudeHash: 'c', settingsBase64: Buffer.from('{"hooks":{"PreToolUse":[{"hooks":[{"command":"node cli-lease.js hook"}]}]}}').toString('base64'),configHash: '', freeKb: 99 * 1048576, present: ['app'], ...over });
const probeOut = (s) => [...Object.entries(s).filter(([k]) => k !== 'present').map(([k, v]) => `${k}=${v}`), ...s.present.flatMap((n) => [`present=${n}`, `origin=${n}=https://github.com/o/${n}.git`])].join('\n');

function exec(s, opts = {}) {
  const calls = [];
  const run = { ssh: (alias, cmd, timeoutMs) => (calls.push(['ssh', alias, cmd, timeoutMs]), calls.length === 1 ? probeOut(s) : ''), scp: (alias, from, to) => calls.push(['scp', alias, from, to]) };
  const logs = [];
  const code = prepareHost({ name: 'box', hosts, config: JSON.parse(body), configPath, local, run, minFreeGb: 10, dryRun: false, log: (m) => logs.push(m), ...opts });
  return { code, calls, logs };
}

test('clones only the absent repo, fetches both, makes the state dir and copies the config', () => {
  const { code, calls } = exec(state());
  assert.equal(code, 0);
  assert.deepEqual(calls.slice(1).map((c) => c[2]), ["git -C '/h/D/app' fetch origin", "gh repo clone 'o/lib' '/h/D/lib'", "git -C '/h/D/lib' fetch origin", `mkdir -p '${hostState}'`, configPath]);
  assert.deepEqual(calls.at(-1), ['scp', 'box', configPath, `${hostState}/config.json`]);
});

test("the probe hashes the config already at box's state dir, not at an undefined path", () => {
  const { calls } = exec(state());
  assert.match(calls[0][2], new RegExp(`shasum -a 256 '${hostState}/config\\.json'`));
  assert.doesNotMatch(calls[0][2], /undefined/);
});

test('a config without emit-config\'s configDir/worktreeDir is refused after the probe and runs nothing', () => {
  const { code, calls, logs } = exec(state(), { config: { ...boxConfig, configDir: undefined } });
  assert.equal(code, 1);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0][2], /undefined/);
  assert.match(logs.join('\n'), /box: config configDir undefined and worktreeDir \S+ are not <dir>\/state/);
});

test('only the clone gets the long timeout; every other call keeps the runner default', () => {
  const { calls } = exec(state());
  assert.deepEqual(calls.filter((c) => c[0] === 'ssh').map((c) => c[3]), [undefined, undefined, CLONE_TIMEOUT_MS, undefined, undefined]);
});

test('a second run with the repos present and the config in place clones and copies nothing', () => {
  const { code, calls } = exec(state({ present: ['app', 'lib'], configHash }));
  assert.equal(code, 0);
  assert.deepEqual(calls.slice(1).map((c) => c[0]), ['ssh', 'ssh', 'ssh']);
  assert.ok(!calls.some((c) => /clone|scp/.test(c[2] ?? '') || c[0] === 'scp'));
});

test('--dry-run runs only the probe and logs the plan', () => {
  const { code, calls, logs } = exec(state(), { dryRun: true });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.ok(logs.some((l) => l.startsWith('would run: clone o/lib')));
});

test('a refusal exits 1 after the probe and runs nothing', () => {
  const { code, calls, logs } = exec(state({ sdSha: 'z' }));
  assert.equal(code, 1);
  assert.equal(calls.length, 1);
  assert.match(logs.join('\n'), /box: ship-dag is at z/);
});

test('a config for another host is refused after the probe', () => {
  const { code, calls, logs } = exec(state(), { config: { ...boxConfig, projectRoot: '/Users/me/Developer/WXYC' } });
  assert.equal(code, 1);
  assert.equal(calls.length, 1);
  assert.match(logs.join('\n'), /box: config projectRoot \/Users\/me\/Developer\/WXYC is not \/h\/D/);
});

// What execFileSync throws: status and code at the top level.
const execError = (props) => Object.assign(new Error('Command failed'), props);
const thrown = (run, opts = {}) => {
  try { prepareHost({ name: 'box', hosts, config: JSON.parse(body), configPath, local, run, minFreeGb: 10, log() {}, ...opts }); } catch (e) { return e; }
  return assert.fail('prepareHost did not throw');
};

for (const [name, error, exitCode] of [
  ['ssh exit 255', execError({ status: 255 }), 3],
  ['a timeout', execError({ code: 'ETIMEDOUT', status: null }), 3],
  ['a missing ssh', execError({ code: 'ENOENT', status: null }), 1],
  ['a normal non-zero status', execError({ status: 1 }), 1],
]) {
  test(`a probe that fails with ${name} names the host and step and exits ${exitCode}`, () => {
    const e = thrown({ ssh: () => { throw error; }, scp: () => {} });
    assert.match(e.message, /host-prepare: box: probe failed: Command failed/);
    assert.equal(e.exitCode, exitCode);
  });
}

// Every call after the probe changes the host, so even a drop there leaves the host in an unknown state.
for (const [name, error] of [['ssh exit 255', execError({ status: 255 })], ['a timeout', execError({ code: 'ETIMEDOUT', status: null })], ['a normal non-zero status', execError({ status: 1 })]]) {
  for (const [step, fails] of [['the first fetch', (n) => n === 2], ['the scp', (n, kind) => kind === 'scp']]) {
    test(`${name} at ${step} exits 1`, () => {
      let n = 0;
      const call = (kind) => { n += 1; if (fails(n, kind)) throw error; return n === 1 ? probeOut(state()) : ''; };
      const e = thrown({ ssh: () => call('ssh'), scp: () => call('scp') });
      assert.equal(e.exitCode, 1);
      assert.match(e.message, /host-prepare: box: (fetch|copy config) .* failed/);
    });
  }
}

test('an unknown host throws, naming the known ones', () => {
  assert.throws(() => prepareHost({ name: 'nope', hosts, config: {}, configPath, local, run: {}, log() {} }), /unknown host "nope"; known: box/);
});

test('the layout reposDir is the engine hooks\' own: the env override, else ~/Developer/WXYC, never undefined', () => {
  assert.equal(layoutReposDir({}), join(homedir(), 'Developer', 'WXYC'));
  assert.equal(layoutReposDir({ SHIP_DAG_PROJECT_ROOT: '/p' }), '/p');
  assert.equal(layoutReposDir({ SHIP_DAG_REPOS_DIR: '/r', SHIP_DAG_PROJECT_ROOT: '/p' }), '/r');
});

test('an unknown flag (a mistyped --dry-run) exits 2 before touching any host', () => {
  const cli = fileURLToPath(new URL('./host-prepare.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [cli, 'box', configPath, '--dryrun'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^unknown option --dryrun; usage: host-prepare\.mjs/);
});

// The whole CLI in-process against the fixture host, with a runner that throws what the real runner's execFileSync throws; nothing connects.
for (const [name, error, expected] of [['ssh exit 255 (an unreachable host)', execError({ status: 255 }), 3], ['a failing remote command', execError({ status: 1 }), 1]]) {
  test(`the CLI exits ${expected} when the probe gets ${name}`, () => {
    const coHomeWas = process.env.CO_HOME;
    process.env.CO_HOME = fileURLToPath(new URL('..', import.meta.url));
    try {
      const lines = [];
      assert.equal(cli(['box', configPath], { hosts, run: { ssh: () => { throw error; }, scp() {} } }, (m) => lines.push(m)), expected);
      assert.match(lines.join('\n'), /host-prepare: box: probe failed/);
    } finally {
      if (coHomeWas === undefined) delete process.env.CO_HOME; else process.env.CO_HOME = coHomeWas;
    }
  });
}
