// Tests for the host-prepare planner and probe parsing. No test opens a connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConfigsByHost } from '../emit-config.mjs';
import { testHost } from './host-fixture.mjs';
import { mergeSettings } from './host-sync-claude.mjs';
import { configStateDir, planHost, probeScript, parseProbe, xcodeRefusal } from './host-prepare.mjs';

const host = testHost('/h', { toolchains: ['node'] });
const hosts = { box: host };
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
  const fake = testHost(home);
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

// The entries claude-orchestrator's `hook --print-settings-entry` prints (lease-hook.ts settingsEntries), its word list
// cut short: the command holds single quotes, `\\[tnr]` in a grep -E pattern (four backslashes in the JSON) and `\n`.
const leaseCommand = `[ "\${CO_LEASE_HOOK:-}" = on ] || exit 0; input=$(cat); [ -n "\${CO_LEASE_PATTERNS_FILE:-}" ] || printf '%s' "$input" | grep -qE 'npm|node([^A-Za-z0-9]|\\\\[tnr])+--test([^A-Za-z0-9_./-]|$)|git.*push' || exit 0; [ -f '/co/dist/src/cli-lease.js' ] || { printf '%s\\n' 'claude-orchestrator-lease hook: /co/dist/src/cli-lease.js is missing; print the settings entries again and install them' >&2; exit 0; }; sp=$PPID; printf '%s' "$input" | CO_LEASE_SESSION_PID=$sp exec node '/co/dist/src/cli-lease.js' hook`;
const leaseGroup = (timeout) => [{ matcher: 'Bash', hooks: [{ type: 'command', command: leaseCommand, ...(timeout && { timeout }) }] }];
const leaseEntry = { hooks: { PreToolUse: leaseGroup(500), PostToolUse: leaseGroup(), PostToolUseFailure: leaseGroup() } };
const other = (command) => ({ matcher: 'Bash', hooks: [{ type: 'command', command }] });

/** Run the generated probe with `sh` against a fake home holding a CLAUDE.md and `settings` as its settings.json (none when undefined). */
function probeSettings(settings) {
  const home = mkdtempSync(join(tmpdir(), 'host-prepare-settings-'));
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'rules\n');
  if (settings !== undefined) writeFileSync(join(home, '.claude', 'settings.json'), settings);
  const fake = testHost(home);
  const r = spawnSync('sh', ['-c', probeScript(fake, undefined, [])], { encoding: 'utf8' });
  return { probe: parseProbe(r.stdout), stderr: r.stderr };
}

for (const [name, settings, leaseHook] of [
  ['the entries hook --print-settings-entry prints', JSON.stringify(leaseEntry, null, 2), true],
  ['those entries on one line', JSON.stringify(leaseEntry), true],
  ['settings.json that mergeSettings wrote with the printed entries', JSON.stringify(mergeSettings({ model: 'x', hooks: { PreToolUse: [other('echo hi')] } }, leaseEntry), null, 2), true],
  ['the entries beside a hook whose command has a newline, a tab and a \\. regex', JSON.stringify(mergeSettings({ hooks: { PreToolUse: [other('a\nb\tc | grep -E "x\\.y"')] } }, leaseEntry), null, 2), true],
  ['a string holding lines that look like probe keys', JSON.stringify({ model: 'x\nclaudeHash=forged\nfreeKb=1\nsdSha=forged', ...leaseEntry }, null, 2), true],
  ['settings.json without it', JSON.stringify({ hooks: { PreToolUse: [other('echo hi')] } }), false],
  ['a lease entry under PostToolUse only, which gates nothing', JSON.stringify({ hooks: { PostToolUse: leaseGroup(), PostToolUseFailure: leaseGroup() } }), false],
  ['settings.json with no hooks', '{"model":"x"}', false],
  ['an absent settings.json', undefined, false],
  ['settings.json that is not JSON', '{"hooks":', false],
]) {
  test(`the probe's lease hook: ${name}`, () => {
    const { probe, stderr } = probeSettings(settings);
    assert.equal(probe.leaseHook, leaseHook);
    assert.equal(stderr, '');
    assert.deepEqual([probe.claudeHash, probe.sdSha], [createHash('sha256').update('rules\n').digest('hex'), '']);
    assert.ok(probe.freeKb > 1);
    assert.equal(/lease hook/.test(run({ leaseHook: probe.leaseHook }).refusals.join('\n')), !leaseHook);
  });
}

// The Xcode gate: a wave that needs xcode refuses a host whose Xcode cannot run, naming the fix.
const XCODE = { xcodePath: '/Applications/Xcode.app/Contents/Developer', xcodeVersion: 'Xcode 27.1' };
for (const [name, over, needs, refused] of [
  ['Xcode.app selected and licensed', XCODE, ['node', 'xcode'], null],
  ['an unaccepted license', { xcodePath: XCODE.xcodePath, xcodeError: 'You have not agreed to the Xcode license agreements. You must agree to the license below in order to use Xcode.' }, ['xcode'], /box: the Xcode license is not accepted \(You have not agreed.*\); run: ssh -t box 'sudo xcodebuild -license accept'/],
  ['Command Line Tools only (xcodebuild says so)', { xcodePath: '/Library/Developer/CommandLineTools', xcodeError: "xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance" }, ['xcode'], /box: xcodebuild is not available and the active developer directory is \/Library\/Developer\/CommandLineTools .*install Xcode\.app and run: ssh -t box 'sudo xcode-select -s \/Applications\/Xcode\.app\/Contents\/Developer'/],
  ['no developer directory and no output', {}, ['xcode'], /active developer directory is none/],
  ['another xcodebuild failure', { xcodePath: XCODE.xcodePath, xcodeError: 'xcodebuild: error: boom' }, ['xcode'], /xcodebuild -version failed \(xcodebuild: error: boom\); active developer directory \/Applications/],
  ['a broken Xcode on a wave that needs no Xcode', {}, ['node'], null],
  ['a broken Xcode when no toolchain is named', {}, undefined, null],
]) {
  test(`the Xcode gate: ${name}`, () => {
    const r = run(over, needs ? { needs } : {});
    if (refused) assert.match(r.refusals.join('\n'), refused);
    else assert.deepEqual(r.refusals, []);
  });
}

test('xcodeRefusal names no host when it is given none', () => {
  assert.match(xcodeRefusal({ xcodeError: 'You have not agreed to the Xcode license agreements.' }), /ssh -t <host> 'sudo xcodebuild -license accept'/);
});

/** The probe against a fake home whose PATH holds stub xcode-select/xcodebuild (none when `stubs` is empty). */
function probeXcode(stubs, opts = { xcode: true }) {
  const home = mkdtempSync(join(tmpdir(), 'host-prepare-xcode-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  for (const [tool, body] of Object.entries(stubs)) {
    writeFileSync(join(bin, tool), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  const fake = validateHosts({ box: { ssh: 'box', home, reposDir: join(home, 'D'), sdHome: join(home, 'D', 'ship-dag') } }).box;
  const r = spawnSync('/bin/sh', ['-c', probeScript(fake, undefined, [], opts)], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
  const { xcodePath, xcodeVersion, xcodeError } = parseProbe(r.stdout);
  return { xcodePath, xcodeVersion, xcodeError, ran: existsSync(join(bin, 'xcodebuild.ran')) };
}

test('the Xcode probe reports the path and the first line of a working xcodebuild -version', () => {
  const probe = probeXcode({ 'xcode-select': 'echo /Applications/Xcode.app/Contents/Developer', xcodebuild: 'echo "Xcode 27.1"; echo "Build version 27A1"' });
  assert.deepEqual([probe.xcodePath, probe.xcodeVersion, probe.xcodeError], ['/Applications/Xcode.app/Contents/Developer', 'Xcode 27.1', undefined]);
  assert.deepEqual(run({ xcodePath: probe.xcodePath, xcodeVersion: probe.xcodeVersion }, { needs: ['xcode'] }).refusals, []);
});

test('the Xcode probe turns an unaccepted license into a refusal', () => {
  const probe = probeXcode({ 'xcode-select': 'echo /Applications/Xcode.app/Contents/Developer', xcodebuild: 'echo "You have not agreed to the Xcode license agreements. You must agree to the license below in order to use Xcode." >&2; echo "Run sudo xcodebuild -license" >&2; exit 69' });
  assert.match(probe.xcodeError, /^You have not agreed to the Xcode license agreements/);
  assert.equal(probe.xcodeVersion, undefined);
  assert.match(run(probe, { needs: ['xcode'] }).refusals.join('\n'), /Xcode license is not accepted/);
});

test('the Xcode probe turns a Command Line Tools host into a refusal', () => {
  const probe = probeXcode({ 'xcode-select': 'echo /Library/Developer/CommandLineTools', xcodebuild: "echo \"xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance\" >&2; exit 1" });
  assert.match(run(probe, { needs: ['xcode'] }).refusals.join('\n'), /Command Line Tools only.*install Xcode\.app/);
});

test('the Xcode probe with tools that print nothing and fail reports an error, and without the option runs no Xcode tool', () => {
  assert.match(run(probeXcode({ 'xcode-select': 'exit 1', xcodebuild: 'exit 1' }), { needs: ['xcode'] }).refusals.join('\n'), /xcodebuild is not available/);
  const probe = probeXcode({ xcodebuild: 'touch "$(dirname "$0")/xcodebuild.ran"; echo Xcode 1' }, {});
  assert.deepEqual([probe.xcodeVersion, probe.xcodePath, probe.ran], [undefined, undefined, false]);
});
