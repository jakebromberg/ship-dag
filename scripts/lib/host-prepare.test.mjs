// Tests for the host-prepare planner and probe parsing. No test opens a connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planHost, probeScript, parseProbe } from './host-prepare.mjs';

const host = { ssh: 'box', home: '/h', reposDir: '/h/D', sdHome: '/h/D/ship-dag' };
const repos = [{ repo: 'o/app', name: 'app', layoutDir: 'app' }];
const local = { sdSha: 'aaa', coSha: 'bbb', claudeHash: 'ccc', configHash: 'new' };
const good = { sdSha: 'aaa', coSha: 'bbb', distMtime: 200, coCommitTime: 100, claudeHash: 'ccc', configHash: 'old', freeGb: 50, present: ['app'] };
const run = (over = {}, extra = {}) => planHost({ name: 'box', host, stateDir: '/h/s', configPath: '/c.json', repos, local, probe: { ...good, ...over }, ...extra });
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
  ['ship-dag differs', { sdSha: 'zzz' }, {}, /ship-dag is at zzz, this Mac at aaa; run: ssh box 'git -C \/h\/D\/ship-dag pull --ff-only'/],
  ['the orchestrator differs', { coSha: 'zzz' }, {}, /claude-orchestrator is at zzz.*pull --ff-only && npm ci && npm run build/],
  ['dist is missing', { distMtime: undefined }, {}, /dist is missing or older/],
  ['dist is older than HEAD', { distMtime: 50 }, {}, /dist is missing or older/],
  ['CLAUDE.md differs', { claudeHash: 'zzz' }, {}, /CLAUDE\.md differs.*host-sync-claude \(#342\)/],
  ['disk is below the default threshold', { freeGb: 9.9 }, {}, /9\.9 GB free.*below 10 GB/],
  ['disk is below a raised threshold', { freeGb: 50 }, { minFreeGb: 60 }, /below 60 GB/],
  ['the repo is vendored elsewhere', {}, { repos: [{ repo: 'o/app', name: 'app', layoutDir: 'Shared/App' }] }, /o\/app lives at Shared\/App, not app.*submodule/],
]) {
  test(`refuses and plans nothing when ${name}`, () => {
    const r = run(over, extra);
    assert.equal(r.plan.length, 0);
    assert.match(r.refusals.join('\n'), message);
  });
}

test('disk exactly at the threshold passes', () => assert.deepEqual(run({ freeGb: 10 }).refusals, []));

test('the probe script round-trips through parseProbe', () => {
  assert.match(probeScript(host, '/h/s', ['app']), /test -d '\/h\/D\/app' && echo present=app/);
  assert.match(probeScript(host, '/h/s', []), /\/h\/Developer\/claude-orchestrator/);
  assert.deepEqual(parseProbe('sdSha=a\ncoCommitTime=5\ndistMtime=\nfreeKb=2097152\npresent=x\npresent=y\n'), { present: ['x', 'y'], sdSha: 'a', coCommitTime: 5, distMtime: undefined, freeKb: 2097152, freeGb: 2 });
});
