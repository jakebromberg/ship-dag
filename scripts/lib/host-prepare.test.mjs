// Tests for the host-prepare planner and probe parsing. No test opens a connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConfigsByHost } from '../emit-config.mjs';
import { validateHosts } from './hosts.mjs';
import { mergeSettings } from './host-sync-claude.mjs';
import { configStateDir, planHost, probeScript, parseProbe } from './host-prepare.mjs';

const hosts = validateHosts({ box: { ssh: 'box', home: '/h', reposDir: '/h/D', sdHome: '/h/D/ship-dag', toolchains: ['node'] } });
const host = hosts.box;
// The configs emit-config --by-host writes: o/app runs on box, o/ios stays on this Mac.
const spec = {
  name: 'ship-dag-run1', repo: 'o/app', stateDir: '/m/.local/state/ship-dag/engine/run1', projectRoot: '/m/D', promptTemplate: '/m/p.md',
  repos: { 'o/app': { baseBranch: 'main', commands: ['npm test'], host: 'box' }, 'o/ios': { baseBranch: 'main', commands: ['xcodebuild test'] } },
  issues: [{ number: 1, title: 'one' }, { number: 2, repo: 'o/ios', title: 'two' }],
};
const configs = Object.fromEntries(buildConfigsByHost(spec, hosts).map((c) => [c.host, c.config]));
const config = configs.box;
const hostState = '/h/.local/state/ship-dag/engine/run1';
const repos = [{ repo: 'o/app', name: 'app', layoutDir: 'app' }];
const local = { sdSha: 'aaa', coSha: 'bbb', claudeHash: 'ccc', configHash: 'new' };
const good = { sdSha: 'aaa', coSha: 'bbb', distNewest: '/co/dist/src/index.js', srcNewer: '', claudeHash: 'ccc', leaseHook: true, configHash: 'old', freeGb: 50, present: ['app'], origins: { app: 'git@github.com:O/app.git' } };
const run = (over = {}, extra = {}) => planHost({ name: 'box', host, config, configPath: '/c.json', repos, local, probe: { ...good, ...over }, ...extra });
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
  ['CLAUDE.md differs', { claudeHash: 'zzz' }, {}, /CLAUDE\.md differs.*run: node scripts\/host-sync-claude\.mjs box/],
  ['the lease hook is absent', { leaseHook: false }, {}, /lease hook.*run: node scripts\/host-sync-claude\.mjs box/],
  ['disk is below the default threshold', { freeGb: 9.9 }, {}, /9\.9 GB free.*below 10 GB/],
  ['disk is below a raised threshold', { freeGb: 50 }, { minFreeGb: 60 }, /below 60 GB/],
  ['the repo is vendored elsewhere', {}, { repos: [{ repo: 'o/app', name: 'app', layoutDir: 'Shared/App' }] }, /o\/app lives at Shared\/App, not app.*submodule/],
  ['the present directory is another repo', { origins: { app: 'https://github.com/x/app' } }, {}, /\/h\/D\/app exists but its origin is https:\/\/github\.com\/x\/app, not o\/app; move it aside/],
  ['the present directory has no origin', { origins: {} }, {}, /\/h\/D\/app exists but its origin is unset, not o\/app/],
  ['two repos share a directory name', { present: [] }, { repos: [...repos, { repo: 'p/app', name: 'app', layoutDir: 'app' }] }, /o\/app and p\/app both clone to \/h\/D\/app/],
  ['the config has no configDir', {}, { config: { ...config, configDir: undefined } }, /config configDir undefined and worktreeDir \/h\/\.local\/state\/ship-dag\/engine\/run1\/worktrees are not <dir>\/state and a path under <dir>; pass the config emit-config --by-host wrote for box/],
  ['the configDir does not end in /state', {}, { config: { ...config, configDir: `${hostState}/conf` } }, /config configDir \/h\/\.local\/state\/ship-dag\/engine\/run1\/conf and worktreeDir .* are not <dir>\/state/],
  ['the worktreeDir is outside the state dir', {}, { config: { ...config, worktreeDir: '/h/wt' } }, /worktreeDir \/h\/wt are not <dir>\/state and a path under <dir>; pass the config/],
  ['the config is this Mac\'s, not box\'s', {}, { config: configs.local }, /config state dir \/m\/\.local\/state\/ship-dag\/engine\/run1 is not under \/h\/.*\n.*projectRoot \/m\/D is not \/h\/D/],
]) {
  test(`refuses and plans nothing when ${name}`, () => {
    const r = run(over, extra);
    assert.equal(r.plan.length, 0);
    assert.match(r.refusals.join('\n'), message);
  });
}

test("emit-config --by-host's config for box plans the clone, fetch, mkdir and copy into box's ~/.local/state/ship-dag/engine/<runId>", () => {
  const r = run({ present: [] });
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(r.plan, [
    { step: 'clone o/app', ssh: "gh repo clone 'o/app' '/h/D/app'", slow: true },
    { step: 'fetch o/app', ssh: "git -C '/h/D/app' fetch origin" },
    { step: 'mkdir stateDir', ssh: `mkdir -p '${hostState}'` },
    { step: 'copy config', scp: ['/c.json', `${hostState}/config.json`] },
  ]);
});

for (const [name, cfg, expected] of [
  ['the --by-host config for box', config, hostState],
  ['the --by-host config for this Mac', configs.local, '/m/.local/state/ship-dag/engine/run1'],
  ['a configDir not ending in /state', { ...config, configDir: `${hostState}/conf` }, undefined],
  ['a worktreeDir outside the state dir', { ...config, worktreeDir: '/h/wt' }, undefined],
  ['a bare /state configDir', { configDir: '/state', worktreeDir: '/worktrees' }, undefined],
  ['no dirs at all', {}, undefined],
]) test(`configStateDir: ${name}`, () => assert.equal(configStateDir(cfg), expected));

test('disk exactly at the threshold passes', () => assert.deepEqual(run({ freeGb: 10 }).refusals, []));

test('a clone is marked slow, so the CLI gives it the long timeout', () => {
  assert.deepEqual(run({ present: [] }).plan.filter((a) => a.slow).map((a) => a.step), ['clone o/app']);
});

test('parseProbe reads key=value lines, freeKb as a number, and every present repo with its origin', () => {
  assert.deepEqual(parseProbe('sdSha=a\ndistNewest=\nsrcNewer=x=y\nfreeKb=2097152\npresent=x\norigin=x=u=1\npresent=y\norigin=y=\n'), { present: ['x', 'y'], origins: { x: 'u=1', y: '' }, sdSha: 'a', distNewest: '', srcNewer: 'x=y', freeKb: 2097152, freeGb: 2, leaseHook: false });
});

/** Run the generated probe with `sh` against a fake host in a temp dir: `app` cloned from o/app, `lib` (the last) absent; ages are seconds ago. */
function probeFakeHost({ dist = true, srcAge = 200, distAge = 100, junkAge } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'host-prepare-probe-'));
  const fake = validateHosts({ box: { ssh: 'box', home, reposDir: join(home, 'D'), sdHome: join(home, 'D', 'ship-dag') } }).box;
  const co = join(home, 'Developer', 'claude-orchestrator');
  const now = Date.now() / 1000;
  const touch = (path, age) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, ''); utimesSync(path, now - age, now - age); };
  touch(join(co, 'src', 'index.ts'), srcAge);
  if (dist) {
    touch(join(co, 'dist', 'src', 'index.js'), distAge);
    utimesSync(join(co, 'dist'), now - 10_000, now - 10_000); // tsc never touches the dist directory entry itself
    if (junkAge !== undefined) touch(join(co, 'dist', 'src', '.DS_Store'), junkAge); // not a tsc output, so not a build
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
  ['a stray .DS_Store newer than the source is not a build, so the edit is still refused', { srcAge: 50, junkAge: 10 }, /dist\/src is older than .*src\/index\.ts/],
]) {
  test(`the probe's dist freshness: ${name}`, () => {
    const { co, probe } = probeFakeHost(opts);
    if (opts.dist !== false) assert.equal(probe.distNewest, join(co, 'dist', 'src', 'index.js'));
    const r = run({ distNewest: probe.distNewest, srcNewer: probe.srcNewer });
    if (refused) assert.match(r.refusals.join('\n'), refused);
    else assert.deepEqual(r.refusals, []);
  });
}

const leaseEntry = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: "exec node '/co/dist/src/cli-lease.js' hook" }] }] } };
for (const [name, file, leaseHook] of [
  ['settings.json with the lease hook', JSON.stringify(leaseEntry), true],
  ['the lease hook on several lines', JSON.stringify(leaseEntry, null, 2), true],
  ['settings.json without it', '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo hi"}]}]}}', false],
  ['settings.json with no hooks', '{"model":"x"}', false],
  ['an absent settings.json', undefined, false],
  ['settings.json that is not JSON', '{"hooks":', false],
]) {
  test(`the probe's lease hook: ${name}`, () => {
    const home = mkdtempSync(join(tmpdir(), 'host-prepare-settings-'));
    if (file !== undefined) { mkdirSync(join(home, '.claude')); writeFileSync(join(home, '.claude', 'settings.json'), file); }
    const fake = validateHosts({ box: { ssh: 'box', home, reposDir: join(home, 'D'), sdHome: join(home, 'D', 'ship-dag') } }).box;
    const probe = parseProbe(execFileSync('sh', ['-c', probeScript(fake, undefined, [])], { encoding: 'utf8' }));
    assert.equal(probe.leaseHook, leaseHook);
    assert.equal(/lease hook/.test(run({ leaseHook: probe.leaseHook }).refusals.join('\n')), !leaseHook);
  });
}

test("settings.json that mergeSettings wrote with a printed entry passes the lease hook check", () => {
  const written = JSON.stringify(mergeSettings({ model: 'x' }, leaseEntry), null, 2);
  assert.equal(parseProbe(`settings=${written.replace(/\n/g, '')}\n`).leaseHook, true);
});
