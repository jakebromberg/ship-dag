// Tests for the tripwire evaluator. Run: node --test "scripts/**/*.test.mjs"
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, evaluateAll, loadTripwires, NO_ENGINE_DIR, STATES, tripwireContext } from './tripwires.mjs';
import { wilson } from './stats.mjs';

const TABLE = loadTripwires();
const NOW = Date.parse('2026-11-01T00:00:00Z');
const rec = (over = {}) => ({
  kind: 'issue', runId: 'sd-20261020-100000', repo: 'o/r', issue: 1, finalState: 'merged', pr: 5, path: 'engine',
  complexity: 'normal', complexitySource: 'entry', implStatus: 'pushed', tuningVersion: 2, ts: '2026-10-20T00:00:00Z', ...over,
});
/** `n` records; `over` is an object, or a function of the index. */
const many = (n, over = {}) => Array.from({ length: n }, (_, i) => rec(typeof over === 'function' ? over(i) : over));
const tw = (id, over = {}) => ({ ...TABLE.tripwires.find((t) => t.id === id), ...over });
const run = (id, records, { twOver, ...ctx } = {}) => evaluate(tw(id, twOver), tripwireContext(records, { version: 2, now: NOW, ...ctx }));
const costed = (usd, over = {}) => rec({ reportId: 'w1', cost: { implement: { costUsd: usd } }, ...over });

describe('the shipped table', () => {
  test('every metric has an evaluator, and over an empty log each tripwire reports a known state', () => {
    const out = evaluateAll(TABLE, tripwireContext([], { version: 2, now: NOW }));
    assert.deepEqual(out.map((o) => o.id), TABLE.tripwires.map((t) => t.id));
    for (const o of out) assert.ok(STATES.includes(o.state), `${o.id}: ${o.state}`);
  });

  test('a metric id with no evaluator fails loudly, naming the tripwire', () => {
    const bad = { tripwires: [tw('T-fallback'), { id: 'T-nope', metric: 'nope' }] };
    assert.throws(() => evaluateAll(bad, tripwireContext([], { version: 2, now: NOW })), /no evaluator for metric "nope" \(T-nope\)/);
  });

  test('a past-due review date is reported on a holding tripwire; a future or absent one is not', () => {
    const ctx = tripwireContext(many(30), { version: 2, now: NOW });
    const states = (reviewDate) => evaluateAll({ tripwires: [tw('T-fallback', { reviewDate })] }, ctx)[0];
    assert.deepEqual([states('2026-10-01').state, states('2026-10-01').reviewOverdue], ['holding', '2026-10-01']);
    assert.equal(states('2026-11-01').reviewOverdue, undefined);
    assert.equal(states('2026-12-01').reviewOverdue, undefined);
    assert.equal(states(null).reviewOverdue, undefined);
  });
});

describe('the version window', () => {
  test('only records of the current tuningVersion count, and a missing version is 0', () => {
    const base = many(73, { exploreOnlyBlocking: 0 });
    assert.equal(run('T-explore-unique', base).state, 'tripped');
    assert.equal(run('T-explore-unique', base.map((r) => ({ ...r, tuningVersion: 1 }))).state, 'pending-instrumentation');
    const unversioned = base.map(({ tuningVersion, ...r }) => r);
    assert.equal(run('T-explore-unique', unversioned, { version: 0 }).state, 'tripped');
    assert.equal(run('T-explore-unique', unversioned).state, 'pending-instrumentation');
  });

  test('retro records never count', () => {
    assert.equal(run('T-fallback', many(30, { kind: 'retro' })).state, 'insufficient-data');
  });
});

// One table per state, per evaluator: [name, records, state].
const TABLES = {
  'T-explore-unique': [
    ['no record carries the source field: pending-instrumentation', many(80), 'pending-instrumentation'],
    ['73 PRs, none explore-only: the upper bound is under 5%', many(73, { exploreOnlyBlocking: 0 }), 'tripped'],
    ['72 PRs: below the minimum sample', many(72, { exploreOnlyBlocking: 0 }), 'insufficient-data'],
    ['73 PRs, 10 explore-only: the interval stays above 5%', many(73, (i) => ({ exploreOnlyBlocking: i < 10 ? 1 : 0 })), 'holding'],
    ['only records that carry the field are evaluated', [...many(73, { exploreOnlyBlocking: 0 }), ...many(20)], 'tripped'],
    ['an unmerged record is not a PR', many(73, { exploreOnlyBlocking: 0, finalState: 'error', pr: null }), 'pending-instrumentation'],
    ['a merged record whose pr parsePr cannot read is not a PR', many(73, { exploreOnlyBlocking: 0, pr: 'n/a' }), 'pending-instrumentation'],
  ],
  'T-scoped': [
    ['no record carries scopedMiss', many(20), 'pending-instrumentation'],
    ['a null scopedMiss is not a pair', many(20, { scopedMiss: null }), 'insufficient-data'],
    ['9 pairs: below the minimum sample', many(9, { scopedMiss: 1 }), 'insufficient-data'],
    ['10 pairs with no miss', many(10, { scopedMiss: 0 }), 'holding'],
    ['10 pairs, one miss', many(10, (i) => ({ scopedMiss: i === 3 ? 1 : 0 })), 'tripped'],
  ],
  'T-reach': [
    ['no record carries exploreOutsideDiff', many(40, { reach: 'in-diff' }), 'pending-instrumentation'],
    ['29 in-diff PRs', many(29, { reach: 'in-diff', exploreOutsideDiff: { outside: 5, total: 10 } }), 'insufficient-data'],
    ['repo-reach PRs are not the sample', [...many(40, { reach: 'repo', exploreOutsideDiff: { outside: 5, total: 10 } }), ...many(5, { reach: 'in-diff', exploreOutsideDiff: { outside: 5, total: 10 } })], 'insufficient-data'],
    ['30 in-diff PRs, 30% of findings outside', many(30, { reach: 'in-diff', exploreOutsideDiff: { outside: 3, total: 10 } }), 'tripped'],
    ['30 in-diff PRs, 10% outside', many(30, { reach: 'in-diff', exploreOutsideDiff: { outside: 1, total: 10 } }), 'holding'],
    ['30 in-diff PRs, 22% outside: the interval still reaches 20%', many(30, { reach: 'in-diff', exploreOutsideDiff: { outside: 2, total: 9 } }), 'holding'],
    ['30 in-diff PRs whose files fetch failed (a null exploreOutsideDiff) are not the sample', many(30, { reach: 'in-diff', exploreOutsideDiff: null }), 'insufficient-data'],
    ['29 recorded in-diff PRs and 5 null ones: below the minimum sample', [...many(29, { reach: 'in-diff', exploreOutsideDiff: { outside: 3, total: 10 } }), ...many(5, { reach: 'in-diff', exploreOutsideDiff: null })], 'insufficient-data'],
  ],
  'T-fallback': [
    ['29 records', many(29, { path: 'workflow' }), 'insufficient-data'],
    ['records older than 30 days are outside the month', many(40, { path: 'workflow', ts: '2026-09-01T00:00:00Z' }), 'insufficient-data'],
    ['30 records, none on the workflow path', many(30), 'holding'],
    ['30 records, half on it', many(30, (i) => ({ path: i % 2 ? 'workflow' : 'engine' })), 'tripped'],
    ['30 records, 4 on it: the interval reaches 10%', many(30, (i) => ({ path: i < 4 ? 'workflow' : 'engine' })), 'holding'],
    ['30 records on the inline path are not fallback', many(30, { path: 'inline' }), 'holding'],
  ],
};
for (const [id, rows] of Object.entries(TABLES)) {
  describe(id, () => {
    for (const [name, records, state] of rows) test(name, () => assert.equal(run(id, records).state, state));
  });
}

describe('T-explore-unique details', () => {
  test('tiers are evaluated apart, any tripped tier trips it, and the coverage share is reported', () => {
    const out = run('T-explore-unique', [...many(73, { exploreOnlyBlocking: 0 }), ...many(5, { complexity: 'complex', exploreOnlyBlocking: 0 }), ...many(20)]);
    assert.deepEqual([out.state, out.tiers.normal.state, out.tiers.complex.state], ['tripped', 'tripped', 'insufficient-data']);
    assert.deepEqual(out.coverage, { have: 78, of: 98 });
  });

  test('a complexitySource: default record is excluded from a tier and counted', () => {
    const out = run('T-explore-unique', [...many(72, { exploreOnlyBlocking: 0 }), ...many(5, { exploreOnlyBlocking: 0, complexitySource: 'default' }), rec({ exploreOnlyBlocking: 0, complexitySource: undefined })]);
    assert.deepEqual([out.state, out.tiers.normal.n, out.dropped], ['tripped', 73, 5]);
  });
});

describe('thresholds and source paths', () => {
  // A bound exactly at the threshold does not clear it: [id, records, trips].
  const atThreshold = [
    ['T-explore-unique', many(73, { exploreOnlyBlocking: 0 }), { upperBelow: wilson(0, 73).hi }],
    ['T-fallback', many(30, (i) => ({ path: i < 3 ? 'workflow' : 'engine' })), { lowerAbove: wilson(3, 30).lo }],
  ];
  for (const [id, records, trips] of atThreshold) {
    test(`${id}: a bound equal to the threshold holds`, () => assert.equal(run(id, records, { twOver: { trips } }).state, 'holding'));
  }

  // The row's `source` names the field, so a nesting under `review` is a data change: [id, source, records].
  const nested = [
    ['T-scoped', 'review.scopedMiss', many(10, (i) => ({ review: { scopedMiss: i === 3 ? 1 : 0 } }))],
    ['T-reach', 'review.exploreOutsideDiff', many(30, { reach: 'in-diff', review: { exploreOutsideDiff: { outside: 3, total: 10 } } })],
  ];
  for (const [id, source, records] of nested) {
    test(`${id} reads its field through the row's source (${source})`, () => assert.equal(run(id, records, { twOver: { source } }).state, 'tripped'));
  }
});

describe('T-scoped details', () => {
  test('reports the pairs and the misses', () => {
    const out = run('T-scoped', many(10, (i) => ({ scopedMiss: i < 2 ? 2 : 0 })));
    assert.deepEqual([out.pairs, out.misses], [10, 4]);
  });
});

describe('T-cost', () => {
  const v1 = (usd, n = 30, over = {}) => many(n, () => costed(usd, { tuningVersion: 1, ...over }));
  const v2 = (usd, n = 30, over = {}) => many(n, () => costed(usd, over));
  const table = [
    ['no record carries cost.implement.costUsd: pending-instrumentation', many(60), 'pending-instrumentation'],
    ['above 1.5x the previous version', [...v1(5), ...v2(10)], 'tripped'],
    ['1.4x the previous version', [...v1(5), ...v2(7)], 'holding'],
    ['29 PRs this version', [...v1(5), ...v2(10, 29)], 'insufficient-data'],
    ['29 PRs in the previous version', [...v1(5, 29), ...v2(10)], 'insufficient-data'],
    ['no previous version to compare with', v2(10), 'insufficient-data'],
    ['a record without a reportId (hand-written) is not used', [...v1(5, 30, { reportId: undefined }), ...v2(10)], 'insufficient-data'],
    ['a later version is not a baseline', [...v1(5), ...v2(7), ...v2(1, 30, { tuningVersion: 3 })], 'holding'],
    ['a mean above 1.5x whose interval still reaches it holds', [...v1(5), ...many(30, (i) => costed(i ? 5 : 95))], 'holding'],
  ];
  for (const [name, records, state] of table) test(name, () => assert.equal(run('T-cost', records).state, state));

  test('compares with the nearest earlier version that has records, tier by tier, and drops assumed tiers with a count', () => {
    const records = [...v1(5, 30, { tuningVersion: 0 }), ...v1(10), ...v2(10), ...v2(99, 4, { complexitySource: 'default' }), ...v2(10, 30, { complexity: 'complex' })];
    const out = run('T-cost', records);
    assert.deepEqual([out.state, out.tiers.normal.state, out.tiers.complex.state, out.dropped], ['holding', 'holding', 'insufficient-data', 4]);
  });

  test('the first 30 PRs of a version are its sample', () => {
    const late = many(30, (i) => costed(100, { ts: `2026-10-25T00:00:${String(i).padStart(2, '0')}Z` }));
    assert.equal(run('T-cost', [...v1(5), ...v2(10), ...late]).state, 'tripped');
    assert.equal(run('T-cost', [...v1(5), ...v2(7), ...late]).state, 'holding');
  });
});

describe('T-escapes', () => {
  const escapes = (current) => ({ byTuningVersion: { 0: { prs: 200, escaped: 20 }, 1: { prs: 100, escaped: 10 }, ...current } });
  const strong = { strong: 12, strongRate: 0.2 };
  const table = [
    ['no escapes input: insufficient-data with the hint', undefined, 'insufficient-data'],
    ['the current version has no tally', escapes({}), 'insufficient-data'],
    ['49 PRs', escapes({ 2: { prs: 49, escaped: 40 } }), 'insufficient-data'],
    ['50% against a 10% baseline', escapes({ 2: { prs: 60, escaped: 30, ...strong } }), 'tripped'],
    ['10% against a 10% baseline', escapes({ 2: { prs: 60, escaped: 6 } }), 'holding'],
    ['20%: above the baseline rate but inside its interval', escapes({ 2: { prs: 60, escaped: 12 } }), 'holding'],
    ['no earlier version has a tally: no baseline to compare with', { byTuningVersion: { 2: { prs: 60, escaped: 30 } } }, 'insufficient-data'],
  ];
  for (const [name, esc, state] of table) test(name, () => assert.equal(run('T-escapes', [], { escapes: esc }).state, state));

  test('without --escapes it says how to produce the file; it takes only the injected object, so it has no way to call gh', () => {
    assert.match(run('T-escapes', []).hint, /run telemetry\.mjs escapes > <file> and pass --escapes <file>/);
  });

  test('a tripped result shows the strong sub-rate and the baseline pooled over earlier versions', () => {
    const out = run('T-escapes', [], { escapes: escapes({ 2: { prs: 60, escaped: 30, ...strong } }) });
    assert.deepEqual([out.strong, out.strongRate, out.baseline.prs, out.baseline.escaped], [12, 0.2, 300, 30]);
  });

  test('before the baseline version closes there is nothing to compare with', () => {
    const out = run('T-escapes', [], { version: 1, escapes: escapes({}) });
    assert.equal(out.state, 'insufficient-data');
  });
});

describe('T-coverage', () => {
  const SINCE = '2026-10-10T00:00:00Z';
  const audited = (rows, uncovered, over = {}) => () => ({ terminalRows: rows, prRows: { total: rows - 10, uncovered: Math.min(uncovered, rows - 10) }, notIngested: uncovered ? [{ refs: Array(uncovered).fill('o/r#1') }] : [], ...over });
  const cov = (records, audit, twOver = { since: SINCE }) => run('T-coverage', records, { audit, twOver });
  const inWindow = many(3, { runId: 'sd-20261020-100000' });

  test('the share of terminal rows covered comes from audit\'s terminalRows, with the PR rows as a sub-share', () => {
    const out = cov(inWindow, audited(100, 2));
    assert.deepEqual([out.state, out.rows.covered, out.rows.total, out.rows.prCovered, out.rows.prTotal], ['holding', 98, 100, 88, 90]);
  });

  test('a record in the same second as since, with milliseconds, is inside the window', () => {
    const recs = many(40, { runId: 'sd-20261010-000000', ts: '2026-10-10T00:00:00.500Z', reportId: 'w1', cost: { implement: { costUsd: 1 } } });
    const out = cov(recs, audited(100, 2));
    assert.deepEqual([out.state, out.cost.state, out.cost.n], ['holding', 'holding', 40]); // both the family and the cost share
  });

  test('the shipped T-coverage window starts at T6 (#73, PR #159)\'s merge', () => {
    assert.equal(TABLE.tripwires.find((t) => t.id === 'T-coverage').since, '2026-10-12T23:52:28Z');
  });

  test('NO_ENGINE_DIR matches only audit\'s refusal, from its start', () => {
    assert.ok(NO_ENGINE_DIR.test('no dir under /x belongs to run sd-1'));
    for (const m of ['audit: no dir under /x belongs to run sd-1', 'no dir', 'EACCES: no dir under /x']) assert.ok(!NO_ENGINE_DIR.test(m), m);
  });

  test('a family whose Wilson upper bound is under 95% trips it', () => {
    assert.equal(cov(inWindow, audited(100, 10)).state, 'tripped');
  });

  test('any tripped family trips it, and each family is reported', () => {
    const recs = [...inWindow, ...many(2, { runId: 'sd-20261021-100000' })];
    const out = cov(recs, (run) => audited(100, run === 'sd-20261021-100000' ? 30 : 0)());
    assert.deepEqual([out.state, out.families.map((f) => f.state)], ['tripped', ['holding', 'tripped']]);
  });

  test('a run with no engine dir is skipped, not tripped, and counted', () => {
    const out = cov(inWindow, () => { throw new Error('no dir under /x belongs to run sd-20261020-100000'); });
    assert.deepEqual([out.state, out.skipped], ['insufficient-data', 1]);
  });

  test('any other audit failure is thrown, not skipped', () => {
    assert.throws(() => cov(inWindow, () => { throw new TypeError('x is undefined'); }), /x is undefined/);
    assert.throws(() => cov(inWindow, () => { throw new Error('EACCES: permission denied'); }), /EACCES/);
  });

  test('a run family from before the window is insufficient-data and is not audited', () => {
    let called = 0;
    const recs = [...inWindow, ...many(2, { runId: 'sd-20260920-100000', ts: '2026-09-20T00:00:00Z' })];
    const out = cov(recs, (...a) => { called += 1; return audited(100, 0)(...a); });
    assert.deepEqual([called, out.families.map((f) => f.state)], [1, ['holding', 'insufficient-data']]);
    assert.equal(cov(many(3, { ts: '2026-09-20T00:00:00Z' }), audited(100, 50)).state, 'insufficient-data');
  });

  test('a family with an earlier tuningVersion only is outside the window', () => {
    assert.equal(cov(many(3, { tuningVersion: 1 }), audited(100, 50)).state, 'insufficient-data');
  });

  test('with no window date set no family is in the window', () => {
    assert.equal(cov(inWindow, audited(100, 50), { since: null }).state, 'insufficient-data');
  });

  test('the cost.implement presence share: pending when no record has it, tripped when it is low, and read alongside the rows', () => {
    const reached = (n, withCost) => many(n, (i) => ({ reportId: 'w1', ...(i < withCost ? { cost: { implement: { costUsd: 1 } } } : {}) }));
    const rows = audited(100, 0);
    assert.deepEqual([cov(reached(10, 0), rows).state, cov(reached(10, 0), rows).cost.state], ['holding', 'pending-instrumentation']);
    const low = cov(reached(100, 70), rows);
    assert.deepEqual([low.state, low.cost.state, low.cost.k, low.cost.n], ['tripped', 'tripped', 70, 100]);
    assert.equal(cov(reached(100, 99), rows).cost.state, 'holding');
  });

  test('the cost share counts only records inside the window: earlier ones predate cost.implement and would read as an ingestion gap, and with no window date set it is insufficient-data', () => {
    const early = many(100, { reportId: 'w1', ts: '2026-10-01T00:00:00Z' });
    const late = many(5, { reportId: 'w1', cost: { implement: { costUsd: 1 } } });
    const out = cov([...early, ...late], audited(100, 0));
    assert.deepEqual([out.cost.state, out.cost.n, out.state], ['holding', 5, 'holding']);
    assert.equal(cov([...early, ...late], audited(100, 0), { since: null }).cost.state, 'insufficient-data');
  });

  test('records that never reached implement, or have no reportId, are not in the cost share', () => {
    const out = cov([...many(5, { reportId: 'w1', cost: { implement: { costUsd: 1 } } }), ...many(40, { implStatus: null, reportId: 'w1' }), ...many(40)], audited(100, 0));
    assert.deepEqual([out.cost.n, out.cost.k], [5, 5]);
  });
});
