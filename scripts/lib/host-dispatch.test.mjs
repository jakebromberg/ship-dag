// Tests for the pure rules of SKILL.md's dual-host dispatch (step 4b and the per-host preflights).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostLaunches, rateLimitGate, routeHostExit } from './host-dispatch.mjs';
import { EXIT } from './remote.mjs';
import { docBetween, docSection } from './doc-pins.mjs';

for (const [script, code, route] of [
  ['host-sync-claude', EXIT.ok, 'host-prepare'],
  ['host-sync-claude', EXIT.unreachable, 'unreachable'],
  ['host-sync-claude', EXIT.failure, 'hitl'],
  ['host-sync-claude', EXIT.usage, 'fix-command'],
  ['host-sync-claude', EXIT.pending, 'hitl'],
  ['host-prepare', EXIT.ok, 'host-run'],
  ['host-prepare', EXIT.unreachable, 'unreachable'],
  ['host-prepare', EXIT.failure, 'hitl'],
  ['host-prepare', EXIT.usage, 'fix-command'],
  ['host-run', EXIT.ok, 'read-reports'],
  ['host-run', EXIT.failure, 'read-reports'],
  ['host-run', EXIT.usage, 'fix-command'],
  ['host-run', EXIT.unreachable, 'unreachable'],
  ['host-run', EXIT.waiting, 'collect-only'],
  ['host-run', EXIT.dropped, 'collect-only'],
  ['host-run', 137, 'hitl'],
  ['host-run', null, 'hitl'],
]) {
  test(`routeHostExit: ${script} exit ${code} -> ${route}`, () => {
    assert.equal(routeHostExit(script, code), route);
  });
}

test('routeHostExit: no host-run exit routes to running the host\'s issues locally', () => {
  const routes = [null, ...Object.values(EXIT), 137].map((code) => routeHostExit('host-run', code));
  assert.ok(!routes.includes('local'));
});

const PROCEED = { action: 'proceed', reason: 'normal', recommendedParallel: 3 };
const WAIT = { action: 'wait', reason: 'critical-wait', recommendedParallel: 0 };
const HITL = { action: 'hitl', reason: 'critical-hitl', recommendedParallel: 0 };

for (const [name, results, expected] of [
  ['every host proceeds', { local: PROCEED, big: { ...PROCEED, recommendedParallel: 2 } }, { launch: { local: 3, big: 2 }, held: {} }],
  ['critical on one host holds only that host', { local: PROCEED, big: WAIT }, { launch: { local: 3 }, held: { big: 'wait' } }],
  ['critical-hitl on the local host holds only the local host', { local: HITL, big: PROCEED }, { launch: { big: 3 }, held: { local: 'hitl' } }],
  ['every host critical launches none', { local: WAIT, big: HITL }, { launch: {}, held: { local: 'wait', big: 'hitl' } }],
  ['a single host', { local: PROCEED }, { launch: { local: 3 }, held: {} }],
  ['no host', {}, { launch: {}, held: {} }],
]) {
  test(`hostLaunches: ${name}`, () => {
    assert.deepEqual(hostLaunches(results), expected);
  });
}

const RATE = (action) => ({ action, resetsAt: '2026-10-22T01:00:00Z' });

for (const [name, decision, uncollected, expected] of [
  ['collected: proceed applies to every host', RATE('proceed'), [], RATE('proceed')],
  ['collected: wait applies to every host', RATE('wait'), [], RATE('wait')],
  ['collected: hitl applies to every host', RATE('hitl'), [], RATE('hitl')],
  ['an uncollected host holds the launch, whatever the decision says', RATE('proceed'), ['big'], { action: 'hold', uncollected: ['big'] }],
  ['two uncollected hosts are all named', RATE('wait'), ['big', 'small'], { action: 'hold', uncollected: ['big', 'small'] }],
]) {
  test(`rateLimitGate: ${name}`, () => {
    assert.deepEqual(rateLimitGate(decision, uncollected), expected);
  });
}

const step4b = docBetween('**b. Invoke the engine.**', '**c. Read the report.**');

for (const [name, rule] of [
  ['the real sync before host-prepare', /host-sync-claude\.mjs <host>.*before `host-prepare\.mjs`/s],
  ['the exit-code table names every route', /\| `3` \|.*unreachable.*\| `4` \|.*--collect-only.*\| `255` \|.*--collect-only/s],
  ['a post-launch drop is never run locally', /never run (that host's|its) issues locally/],
  ['the remote preflight goes through host-run --preflight', /host-run\.mjs" <host> "\$WAVE_DIR\/hosts\/config\.<host>\.json" --state "\$WAVE_DIR<letter>" --preflight/],
  ['every command uses the wave dir, never the run dir $STATE', /`\$WAVE_DIR` = `<engine base>\/<RUN_ID>-w<W>`/],
  ['a remote re-run syncs, prepares and preflights the host before host-run', /filtered re-run of a remote row.*host-sync-claude\.mjs.*host-prepare\.mjs.*host-run\.mjs --preflight.*then `host-run\.mjs`/s],
  ['each host collects into its own dir', /<RUN_ID>-w<W><letter>/],
  ['the rate-limit preflight waits for every host to be collected', /every host's sub-wave .* collected/s],
  ['no hosts configured follows today\'s path', /no hosts configured.*(today's|exactly the) path/is],
]) {
  test(`SKILL.md step 4b states ${name}`, () => {
    assert.match(step4b, rule);
  });
}

const policy = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../references/escalation-policy.md'), 'utf8');
const step5 = docSection('### 5. Reconcile each result');

test('step 5 holds no hand-written ssh line, and names the exists: false case in the escalation policy', () => {
  assert.doesNotMatch(step5, /ssh <alias>|rev-list --count/);
  assert.match(step5, /`exists: false` is a worktree that no longer exists/);
  assert.match(policy, /host-run\.mjs --worktree <path> --base <branch>.*If the host worktree no longer exists \(`exists: false`\)/s);
});

test('escalation-policy.md offers run locally / wait / defer for an unreachable host, and the three point-E choices for a remote row', () => {
  assert.match(policy, /## A remote host that cannot run its sub-wave, and remote rows/);
  assert.match(policy, /\*\*run its issues locally\*\*.*\*\*wait\*\*.*\*\*defer\*\*/s);
  assert.match(policy, /\*\*re-run it on the host\*\*.*\*\*continue locally from the pushed branch\*\*.*\*\*defer\*\*.*Nothing runs a continuation session on the host/s);
  assert.match(policy, /re-run it on the host\*\* \(a filtered re-run: .*host-sync-claude.*host-prepare.*host-run --preflight/);
});

test('SKILL.md step 5 sends a remote row that would resume in place to point E, reading its commit count and dirty flag with host-run --worktree', () => {
  assert.match(step5, /resource preflight \(step 4\) first, for a remote row the host's own \(`host-run\.mjs --preflight`/);
  assert.match(step5, /remote row.*host-run\.mjs" <host> .*--worktree <worktree> --base <base>.*exit 3 means ssh dropped.*exit 1 means the read failed.*HITL point E.*re-run it on the host, continue locally from the pushed branch, or defer.*nothing runs a continuation session on the host/s);
});

// The table in step 4b item 4 and routeHostExit are two copies of one rule; each row is checked against routeHostExit.
const ROUTE_WORDS = {
  'host-prepare': /^the next step/,
  'host-run': /^the next step/,
  'read-reports': /read the reports/,
  'collect-only': /--collect-only/,
  unreachable: /^unreachable/,
  'fix-command': /^usage: fix the command/,
  hitl: /^a failed sync/,
};

// The first script cell lists several scripts and continuation rows leave it blank, so the script carries down.
function exitRouteRows() {
  const rows = [];
  let scripts = [];
  for (const line of step4b.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| script') && !l.startsWith('|---'))) {
    const [scriptCell, exitCell, ...routeCells] = line.slice(1, -1).split('|').map((c) => c.trim());
    if (scriptCell) scripts = [...scriptCell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const code = Number(exitCell.replaceAll('`', ''));
    for (const script of scripts) rows.push({ script, code, route: routeCells.join('|') });
  }
  return rows;
}

test('SKILL.md step 4b exit-route table agrees with routeHostExit, row by row', () => {
  const rows = exitRouteRows();
  assert.ok(rows.length > 0);
  for (const { script, code, route } of rows) {
    const words = ROUTE_WORDS[routeHostExit(script, code)];
    const matching = new Set(Object.values(ROUTE_WORDS).filter((w) => w.test(route)).map(String));
    assert.deepEqual([...matching], [String(words)], `${script} exit ${code}: "${route}"`);
  }
});

// Every code step 4b can receive has a row: each script's expected codes are all of EXIT less its named exclusions, so a
// new EXIT code fails here until it gets a table row or an exclusion with a reason.
const NOT_RETURNED = {
  // Only `host-sync-claude --dry-run` returns pending, and step 4b always runs the real sync.
  pending: ['host-sync-claude', 'host-prepare', 'host-run'],
  // Only host-run waits for an engine or launches one that a drop can follow.
  waiting: ['host-sync-claude', 'host-prepare'],
  dropped: ['host-sync-claude', 'host-prepare'],
};

test('SKILL.md step 4b exit-route table has a row for every code each script returns to it', () => {
  const returned = Object.fromEntries(
    ['host-sync-claude', 'host-prepare', 'host-run'].map((s) => [
      s,
      Object.entries(EXIT).filter(([k]) => !NOT_RETURNED[k]?.includes(s)).map(([, c]) => c),
    ]),
  );
  const have = exitRouteRows().map((r) => `${r.script} ${r.code}`).sort();
  const want = Object.entries(returned).flatMap(([s, codes]) => codes.map((c) => `${s} ${c}`)).sort();
  assert.deepEqual(have, want);
});
