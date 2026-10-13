// Tests for the resource-preflight I/O wrapper. The lease API is injected, so
// nothing here reads sysctl or the real lease directory.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkResource, parseArgs } from './resource-preflight.mjs';

const status = (level, capacity = 4, live = []) => ({ level, capacity, live });
const lease = (st, seen = []) => ({
  leaseOptionsFor: (env) => { seen.push(env); return { tag: 'opts' }; },
  leaseStatus: (opts) => { assert.deepEqual(opts, { tag: 'opts' }); return st; },
});

// every `reason`: sampled status + flags → decision
const TABLE = [
  [status('normal'), {}, 'proceed', 'normal', 3],
  [status('warning', 1), {}, 'proceed', 'warning-engine-adapts', 3],
  [status('unknown'), {}, 'proceed', 'no-signal', 3],
  [status('critical', 0), { waitedMinutes: 14 }, 'wait', 'critical-wait', 0],
  [status('critical', 0), { waitedMinutes: 15 }, 'hitl', 'critical-hitl', 0],
  [status('critical', 0), { waitedMinutes: 16 }, 'hitl', 'critical-hitl', 0],
];

for (const [st, flags, action, reason, recommendedParallel] of TABLE) {
  test(`checkResource: ${st.level} ${JSON.stringify(flags)} → ${reason}`, async () => {
    const out = await checkResource({ parallel: 3, ...flags }, { env: {}, ...lease(st) });
    assert.deepEqual(out, { action, reason, level: st.level, capacity: st.capacity, live: [], recommendedParallel });
  });
}

test('checkResource: the env handed to leaseOptionsFor lacks CO_PRESSURE_OVERRIDE, and the caller\'s env is untouched', async () => {
  const seen = [];
  const env = { CO_PRESSURE_OVERRIDE: 'critical-as-warning', CO_HOME: '/x', HOME: '/h' };
  const out = await checkResource({ parallel: 3 }, { env, ...lease(status('critical', 0), seen) });
  assert.equal(out.reason, 'critical-wait');
  assert.deepEqual(seen, [{ CO_HOME: '/x', HOME: '/h' }]);
  assert.equal(env.CO_PRESSURE_OVERRIDE, 'critical-as-warning');
});

test('checkResource: --sleep-before waits before it samples', async () => {
  const events = [];
  const sleep = async (ms) => { events.push(`sleep ${ms}`); };
  const leaseStatus = () => { events.push('sample'); return status('normal'); };
  await checkResource({ sleepBefore: 60 }, { env: {}, leaseOptionsFor: () => ({}), leaseStatus, sleep });
  assert.deepEqual(events, ['sleep 60000', 'sample']);
  events.length = 0;
  await checkResource({}, { env: {}, leaseOptionsFor: () => ({}), leaseStatus, sleep });
  assert.deepEqual(events, ['sample']);
});

// --waited-minutes is the total waited before this call; the call adds its own --sleep-before (seconds) before deciding.
for (const [waitedMinutes, sleepBefore, action] of [[13, 60, 'wait'], [14, 60, 'hitl'], [14, 0, 'wait'], [14, 30, 'wait'], [14.5, 30, 'hitl']]) {
  test(`checkResource: critical with ${waitedMinutes} min waited + ${sleepBefore} s sleep → ${action}`, async () => {
    const out = await checkResource({ waitedMinutes, sleepBefore, waitMaxMinutes: 15 }, { env: {}, ...lease(status('critical', 0)), sleep: async () => {} });
    assert.equal(out.action, action);
  });
}

test('checkResource: a CO_HOME whose dist lacks the exports fails open as lease-unavailable', async () => {
  const home = mkdtempSync(join(tmpdir(), 'co-home-'));
  after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'dist', 'src'), { recursive: true });
  writeFileSync(join(home, 'dist', 'src', 'index.js'), 'export const other = 1;\n');
  const out = await checkResource({ parallel: 2 }, { env: { CO_HOME: home } });
  assert.equal(out.action, 'proceed');
  assert.equal(out.reason, 'lease-unavailable');
  assert.equal(out.recommendedParallel, 2);
  assert.match(out.detail, /leaseStatus/);
});

test('checkResource: a CO_HOME that fails to import, or a throwing sampler, fails open too', async () => {
  const missing = await checkResource({ parallel: 2 }, { env: { CO_HOME: join(tmpdir(), 'no-such-co-home') } });
  assert.deepEqual([missing.action, missing.reason, missing.recommendedParallel], ['proceed', 'lease-unavailable', 2]);
  const throwing = await checkResource({ parallel: 2 }, { env: {}, leaseOptionsFor: () => ({}), leaseStatus: () => { throw new Error('boom'); } });
  assert.deepEqual([throwing.reason, throwing.detail], ['lease-unavailable', 'boom']);
});

test('parseArgs: defaults, valid flags and rejected values', () => {
  assert.deepEqual(parseArgs([]), { parallel: undefined, waitedMinutes: 0, waitMaxMinutes: 15, sleepBefore: 0 });
  assert.deepEqual(parseArgs(['--parallel', '2', '--waited-minutes', '3', '--wait-max-minutes', '5', '--sleep-before', '60']),
    { parallel: 2, waitedMinutes: 3, waitMaxMinutes: 5, sleepBefore: 60 });
  for (const bad of [['--parallel', '0'], ['--parallel', '0.5'], ['--parallel', '2.5'], ['--parallel', 'x'], ['--waited-minutes', '-1'], ['--wait-max-minutes', '0'], ['--sleep-before', ''], ['--sleep-before']]) {
    assert.throws(() => parseArgs(bad), /--/, bad.join(' '));
  }
});

// Doc pins: the prose the main agent follows must keep point F and its four choices.
const REPO_ROOT = join(import.meta.dirname, '..');
const skill = readFileSync(join(REPO_ROOT, 'SKILL.md'), 'utf8');
const policy = readFileSync(join(REPO_ROOT, 'references', 'escalation-policy.md'), 'utf8');
const pointFStart = policy.indexOf('## Point F');
const pointF = pointFStart < 0 ? '' : policy.slice(pointFStart).split(/\n## /)[0];

test('SKILL.md: the Guardrails list of HITL points includes F, and step 4 runs the resource preflight', () => {
  assert.match(skill, /the six HITL points \(A triage, B implement\/review, C cross-repo cutover, D retrospective and tripwires, E rate-limit window, F resource pressure\)/);
  assert.match(skill, /resource-preflight\.mjs" check/);
  assert.match(skill, /--parallel <recommendedParallel>/);
  assert.match(skill, /--sleep-before 60 --waited-minutes/);
  assert.match(skill, /reset the summed-wait counter to 0/);
});

test('escalation-policy.md: point F offers its four choices and starts anyway only through the inline override', () => {
  assert.match(policy, /six human-in-the-loop points/);
  assert.ok(pointF.length > 0, 'a "## Point F" section');
  for (const choice of ['**wait**', '**start anyway**', '**defer this step**', '**stop the run**']) assert.ok(pointF.includes(choice), choice);
  assert.ok(pointF.includes('CO_PRESSURE_OVERRIDE=critical-as-warning … run.mts wave --parallel 1'));
  assert.ok(pointF.includes('pressureOverride: true'));
  assert.match(pointF, /reset the summed-wait counter to 0/);
  assert.doesNotMatch(`${skill}\n${policy}`, /export CO_PRESSURE_OVERRIDE/);
});
