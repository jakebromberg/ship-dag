// Tests for the host-prepare planner and probe parsing. No test opens a connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planHost, probeScript, parseProbe } from './host-prepare.mjs';

const host = { ssh: 'box', home: '/h', reposDir: '/h/D', sdHome: '/h/D/ship-dag' };
const repos = [{ repo: 'o/app', name: 'app', layoutDir: 'app' }];
const local = { sdSha: 'aaa', coSha: 'bbb', claudeHash: 'ccc', configHash: 'new' };
const good = { sdSha: 'aaa', coSha: 'bbb', distNewest: '/co/dist/src/index.js', srcNewer: '', claudeHash: 'ccc', configHash: 'old', freeGb: 50, present: ['app'], origins: { app: 'git@github.com:O/app.git' } };
const run = (over = {}, extra = {}) => planHost({ name: 'box', host, stateDir: '/h/s', projectRoot: '/h/D', configPath: '/c.json', repos, local, probe: { ...good, ...over }, ...extra });
const steps = (r) => r.plan.map((a) => a.step);

for (const [name, over, extra, expected] of [
  ['everything matches and the repo is present', {}, {}, ['fetch o/app', 'mkdir stateDir', 'copy config']],
  ['the repo is absent, so it is cloned then fetched', { present: [] }, {}, ['clone o/app', 'fetch o/app', 'mkdir stateDir', 'copy config']],
  ['the config is already in place', { configHash: 'new' }, {}, ['fetch o/app', 'mkdir stateDir']],
]) {
  test(`plans: ${name}`, () => {
    const r = run(over, extra);
    assert.deepEqual(r.refusals, []);
    assert.deepEqual(steps(r), expected);
  });
}

for (const [name, over, extra, message] of [
  ['ship-dag differs', { sdSha: 'zzz' }, {}, /ship-dag is at zzz, this Mac at aaa; run: ssh box 'cd \/h\/D\/ship-dag && git pull --ff-only'/],
  ['the orchestrator differs', { coSha: 'zzz' }, {}, /claude-orchestrator is at zzz.*'cd \/h\/Developer\/claude-orchestrator && git pull --ff-only && npm ci && npm run build'/],
  ['dist is missing', { distNewest: '' }, {}, /dist\/src is missing; run: ssh box 'cd \/h\/Developer\/claude-orchestrator && npm ci && npm run build'/],
  ['a source is newer than dist', { srcNewer: '/co/src/a.ts' }, {}, /dist\/src is older than \/co\/src\/a\.ts; run: .*npm run build/],
  ['CLAUDE.md differs', { claudeHash: 'zzz' }, {}, /CLAUDE\.md differs.*host-sync-claude \(#342\)/],
  ['disk is below the default threshold', { freeGb: 9.9 }, {}, /9\.9 GB free.*below 10 GB/],
  ['disk is below a raised threshold', { freeGb: 50 }, { minFreeGb: 60 }, /below 60 GB/],
  ['the repo is vendored elsewhere', {}, { repos: [{ repo: 'o/app', name: 'app', layoutDir: 'Shared/App' }] }, /o\/app lives at Shared\/App, not app.*submodule/],
  ['the present directory is another repo', { origins: { app: 'https://github.com/x/app' } }, {}, /\/h\/D\/app exists but its origin is https:\/\/github\.com\/x\/app, not o\/app; move it aside/],
  ['the present directory has no origin', { origins: {} }, {}, /\/h\/D\/app exists but its origin is unset, not o\/app/],
  ['two repos share a directory name', { present: [] }, { repos: [...repos, { repo: 'p/app', name: 'app', layoutDir: 'app' }] }, /o\/app and p\/app both clone to \/h\/D\/app/],
  ['the config has no stateDir', {}, { stateDir: undefined }, /config stateDir undefined is not under \/h\/; pass the config emit-config --by-host wrote for box/],
  ['the config is another host\'s', {}, { stateDir: '/elsewhere/s', projectRoot: '/elsewhere/D' }, /stateDir \/elsewhere\/s is not under \/h\/.*\n.*projectRoot \/elsewhere\/D is not \/h\/D/],
]) {
  test(`refuses and plans nothing when ${name}`, () => {
    const r = run(over, extra);
    assert.equal(r.plan.length, 0);
    assert.match(r.refusals.join('\n'), message);
  });
}

test('disk exactly at the threshold passes', () => assert.deepEqual(run({ freeGb: 10 }).refusals, []));

test('a clone is marked slow, so the CLI gives it the long timeout', () => {
  assert.deepEqual(run({ present: [] }).plan.filter((a) => a.slow).map((a) => a.step), ['clone o/app']);
});

test('parseProbe reads key=value lines, freeKb as a number, and every present repo with its origin', () => {
  assert.deepEqual(parseProbe('sdSha=a\ndistNewest=\nsrcNewer=x=y\nfreeKb=2097152\npresent=x\norigin=x=u=1\npresent=y\norigin=y=\n'), { present: ['x', 'y'], origins: { x: 'u=1', y: '' }, sdSha: 'a', distNewest: '', srcNewer: 'x=y', freeKb: 2097152, freeGb: 2 });
});

/** Run the generated probe with `sh` against a fake host in a temp dir: `app` cloned from o/app, `lib` (the last) absent; ages are seconds ago. */
function probeFakeHost({ dist = true, srcAge = 200, distAge = 100 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'host-prepare-probe-'));
  const fake = { ssh: 'box', home, reposDir: join(home, 'D'), sdHome: join(home, 'D', 'ship-dag') };
  const co = join(home, 'Developer', 'claude-orchestrator');
  const now = Date.now() / 1000;
  const touch = (path, age) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, ''); utimesSync(path, now - age, now - age); };
  touch(join(co, 'src', 'index.ts'), srcAge);
  if (dist) {
    touch(join(co, 'dist', 'src', 'index.js'), distAge);
    utimesSync(join(co, 'dist'), now - 10_000, now - 10_000); // tsc never touches the dist directory entry itself
  }
  mkdirSync(join(fake.reposDir, 'app'), { recursive: true });
  execFileSync('git', ['-C', join(fake.reposDir, 'app'), 'init', '-q']);
  execFileSync('git', ['-C', join(fake.reposDir, 'app'), 'remote', 'add', 'origin', 'https://github.com/o/app.git']);
  return { co, probe: parseProbe(execFileSync('sh', ['-c', probeScript(fake, join(home, 's'), ['app', 'lib'])], { encoding: 'utf8' })) };
}

test('the probe exits 0 when the last repo is absent, and reports only the present ones with their origins', () => {
  const { probe } = probeFakeHost();
  assert.deepEqual([probe.present, probe.origins], [['app'], { app: 'https://github.com/o/app.git' }]);
  assert.deepEqual(run({ present: probe.present, origins: probe.origins }).refusals, []);
});

for (const [name, opts, refused] of [
  ['dist built after its sources passes, however old the dist directory entry', {}, null],
  ['a source edited after the build is refused', { srcAge: 50 }, /dist\/src is older than .*src\/index\.ts/],
  ['a missing dist is refused', { dist: false }, /dist\/src is missing/],
]) {
  test(`the probe's dist freshness: ${name}`, () => {
    const { co, probe } = probeFakeHost(opts);
    if (opts.dist !== false) assert.equal(probe.distNewest, join(co, 'dist', 'src', 'index.js'));
    const r = run({ distNewest: probe.distNewest, srcNewer: probe.srcNewer });
    if (refused) assert.match(r.refusals.join('\n'), refused);
    else assert.deepEqual(r.refusals, []);
  });
}
