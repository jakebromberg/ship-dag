// Tests for the status board's pure model. Run: node --test scripts/board/
//
// Every function here is pure, so each is pinned by a table of small graphs
// written as edge lists: `[blocker, blocked]` pairs over short refs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify, buildGraph, orderSteps, projectWaves, leadingWaveNumber, makeShortRef, makeRepoLabel, formatPacific, compareRefs, shippedBefore, closedKind,
} from './model.mjs';

const R = (n) => `o/r#${n}`;
const edgesOf = (pairs) => pairs.map(([a, b]) => ({ blockedBy: R(a), blocked: R(b) }));

// ---- classify ------------------------------------------------------------

for (const [want, ticket] of [
  ['dropped', { state: 'CLOSED', stateReason: 'NOT_PLANNED', hasOpenPr: false, owned: true, openBlockers: 1 }],
  ['dropped', { state: 'CLOSED', stateReason: 'DUPLICATE', hasOpenPr: false, owned: false, openBlockers: 0 }],
  ['shipped', { state: 'CLOSED', stateReason: 'COMPLETED', hasOpenPr: false, owned: false, openBlockers: 0 }],
  ['shipped', { state: 'CLOSED', stateReason: null, hasOpenPr: true, owned: false, openBlockers: 0 }],
  ['flight', { state: 'OPEN', hasOpenPr: true, owned: true, openBlockers: 2 }],
  ['you', { state: 'OPEN', hasOpenPr: false, owned: true, openBlockers: 2 }],
  ['blocked', { state: 'OPEN', hasOpenPr: false, owned: false, openBlockers: 1 }],
  ['ready', { state: 'OPEN', hasOpenPr: false, owned: false, openBlockers: 0 }],
]) {
  test(`classify → ${want} for ${JSON.stringify(ticket)}`, () => {
    assert.equal(classify(ticket), want);
  });
}

// ---- buildGraph ----------------------------------------------------------

test('buildGraph lays a chain out one step per ticket and reports it as the longest chain', () => {
  const g = buildGraph([R(1), R(2), R(3)], edgesOf([[1, 2], [2, 3]]), []);
  assert.deepEqual(g.steps, [[R(1)], [R(2)], [R(3)]]);
  assert.deepEqual(g.chain, [R(1), R(2), R(3)]);
  assert.deepEqual([...g.ancestors.get(R(3))].sort(), [R(1), R(2)]);
  assert.deepEqual([...g.descendants.get(R(1))].sort(), [R(2), R(3)]);
});

test('buildGraph drops a direct edge implied by a longer path (transitive reduction)', () => {
  // 1→2→4, 1→3→4, and the shortcut 1→4: the shortcut is implied, so not drawn.
  const g = buildGraph([1, 2, 3, 4].map(R), edgesOf([[1, 2], [2, 4], [1, 3], [3, 4], [1, 4]]), []);
  assert.deepEqual([...g.direct.get(R(4))].sort(), [R(2), R(3)]);
  assert.deepEqual([...g.preds.get(R(4))].sort(), [R(1), R(2), R(3)], 'preds keeps every edge');
  assert.deepEqual(g.steps, [[R(1)], [R(2), R(3)], [R(4)]]);
});

test('buildGraph places a ticket at its longest path from a ready ticket, not its shortest', () => {
  const g = buildGraph([1, 2, 3, 4].map(R), edgesOf([[1, 2], [2, 3], [1, 4], [3, 4]]), []);
  assert.equal(g.stepOf.get(R(4)), 3);
});

test('buildGraph satisfies an edge from a done ticket outside the open set, and never draws it', () => {
  const g = buildGraph([R(2)], edgesOf([[1, 2]]), [R(1)]);
  assert.deepEqual(g.steps, [[R(2)]]);
  assert.equal(g.preds.get(R(2)).size, 0);
});

// An open blocker outside the board's set is what the engine sees too: the
// ticket can never start this run, so it gets no step.
test('buildGraph makes a ticket waiting on an open blocker outside the set unorderable, and what waits on it', () => {
  const g = buildGraph([2, 3, 4].map(R), edgesOf([[1, 2], [2, 3]]), []);
  assert.deepEqual(g.steps, [[R(4)]]);
  assert.deepEqual([...g.unorderable].sort(), [R(2), R(3)]);
  assert.equal(g.preds.get(R(2)).size, 0, 'an out-of-set blocker is never drawn');
});

test('buildGraph makes a self-edge unorderable, as planWaves calls it cyclic', () => {
  const g = buildGraph([R(1), R(2)], edgesOf([[1, 1]]), []);
  assert.deepEqual(g.steps, [[R(2)]]);
  assert.deepEqual([...g.unorderable], [R(1)]);
});

test('buildGraph breaks a longest-chain tie by ref order, numeric within a repo', () => {
  assert.deepEqual(buildGraph([R(9), R(10)], [], []).chain, [R(10)]);
});

test('buildGraph reports a cycle as unorderable instead of giving it a step', () => {
  const g = buildGraph([1, 2, 3, 4].map(R), edgesOf([[1, 2], [2, 3], [3, 2], [3, 4]]), []);
  assert.deepEqual(g.steps, [[R(1)]]);
  assert.deepEqual([...g.unorderable].sort(), [R(2), R(3), R(4)]);
  assert.equal(g.stepOf.has(R(2)), false);
});

// A ref both open and done is done, as the engine reads it: the engine drops it
// from the nodes, so the board must drop it from preds and ancestry too.
test('buildGraph treats a ref in both openRefs and done as done', () => {
  const g = buildGraph([R(1), R(2)], edgesOf([[1, 2]]), [R(1)]);
  assert.deepEqual(g.steps, [[R(2)]]);
  assert.equal(g.preds.has(R(1)), false);
  assert.equal(g.preds.get(R(2)).size, 0);
  assert.deepEqual(g.chain, [R(2)]);
});

// A forgotten `done` would leave every ticket behind a closed blocker unorderable.
test('buildGraph requires done', () => {
  assert.throws(() => buildGraph([R(2)], edgesOf([[1, 2]])), /done is required/);
});

test('buildGraph on no open tickets is empty', () => {
  const g = buildGraph([], [], []);
  assert.deepEqual(g.steps, []);
  assert.deepEqual(g.chain, []);
});

// ---- orderSteps ----------------------------------------------------------

test('orderSteps puts the ticket that unblocks most first, then keeps children under their parents', () => {
  // Step 0: 1 unblocks one ticket, 2 unblocks two. Step 1: 3 (under 1) and 4 (under 2).
  const g = buildGraph([1, 2, 3, 4, 5].map(R), edgesOf([[1, 3], [2, 4], [4, 5]]), []);
  assert.deepEqual(orderSteps(g), [[R(2), R(1)], [R(4), R(3)], [R(5)]]);
});

test('orderSteps breaks ties by ref order, numeric within a repo', () => {
  assert.deepEqual(orderSteps(buildGraph([R(10), R(9)], [], [])), [[R(9), R(10)]]);
});

test('compareRefs orders by repo, then numerically', () => {
  assert.deepEqual([R(10), 'a/b#2', R(9)].sort(compareRefs), ['a/b#2', R(9), R(10)]);
});

// ---- projectWaves / leadingWaveNumber ------------------------------------

for (const [id, n] of [['31', 31], ['31b', 31], ['4b', 4], ['1′', 1], ['', 0], [undefined, 0]]) {
  test(`leadingWaveNumber(${JSON.stringify(id)}) is ${n}`, () => assert.equal(leadingWaveNumber(id), n));
}

test('projectWaves: building now keeps the wave id; dependents follow it numerically', () => {
  // 1 is building in wave 31b; 2 waits on it; 3 waits on 2; 4 has no blockers and isn't building.
  const g = buildGraph([1, 2, 3, 4].map(R), edgesOf([[1, 2], [2, 3]]), []);
  const status = new Map([[R(1), 'flight'], [R(2), 'blocked'], [R(3), 'blocked'], [R(4), 'ready']]);
  const w = projectWaves(g, status, { id: '31b', refs: new Set([R(1)]) });
  assert.deepEqual(w.get(R(1)), { label: '31b', now: true });
  assert.deepEqual(w.get(R(2)), { label: '32', now: false });
  assert.deepEqual(w.get(R(3)), { label: '33', now: false });
  assert.deepEqual(w.get(R(4)), { label: '32', now: false });
});

test('projectWaves: a ticket of yours takes no wave, and what waits on it goes after its own blockers', () => {
  // 1 (building, wave 5) → 2 (yours) → 3.
  const g = buildGraph([1, 2, 3].map(R), edgesOf([[1, 2], [2, 3]]), []);
  const status = new Map([[R(1), 'flight'], [R(2), 'you'], [R(3), 'blocked']]);
  const w = projectWaves(g, status, { id: '5', refs: new Set([R(1)]) });
  assert.deepEqual(w.get(R(2)), { label: null, now: false });
  assert.deepEqual(w.get(R(3)), { label: '6', now: false });
});

test('projectWaves with no wave yet starts at 1, and skips unorderable tickets', () => {
  const g = buildGraph([1, 2, 3].map(R), edgesOf([[2, 3], [3, 2]]), []);
  const status = new Map([[R(1), 'ready'], [R(2), 'blocked'], [R(3), 'blocked']]);
  const w = projectWaves(g, status, null);
  assert.deepEqual(w.get(R(1)), { label: '1', now: false });
  assert.equal(w.has(R(2)), false);
});

// ---- makeShortRef --------------------------------------------------------

test('makeShortRef uses the repo name, an explicit abbreviation, or owner/repo when names collide', () => {
  const short = makeShortRef(['a/api', 'a/web', 'b/web', 'a/ios'], { 'a/ios': 'iOS' });
  assert.equal(short('a/api#3'), 'api#3');
  assert.equal(short('a/ios#9'), 'iOS#9');
  assert.equal(short('a/web#1'), 'a/web#1');
  assert.equal(short('b/web#2'), 'b/web#2');
});

for (const [name, repos, abbreviations, ref, want] of [
  ['a bare ref is shown as given', ['a/api'], {}, '12', '12'],
  ['a ref that is not owner/repo#N is shown as given', ['a/api'], {}, 'a/api#x', 'a/api#x'],
  ['names differing only in case collide', ['a/Web', 'b/web'], {}, 'a/Web#1', 'a/Web#1'],
  ['an abbreviation matches the repo in any case', ['a/ios'], { 'a/ios': 'iOS' }, 'A/IOS#9', 'iOS#9'],
]) {
  test(`makeShortRef: ${name}`, () => assert.equal(makeShortRef(repos, abbreviations)(ref), want));
}

test('makeRepoLabel labels a repo the way makeShortRef labels its refs', () => {
  const label = makeRepoLabel(['a/api', 'a/web', 'b/web', 'a/ios'], { 'a/ios': 'iOS' });
  assert.deepEqual(['a/api', 'a/ios', 'a/web'].map(label), ['api', 'iOS', 'a/web']);
});

// ---- formatPacific -------------------------------------------------------

for (const [iso, style, want] of [
  ['2026-10-08T20:02:00Z', 'long', 'Thu Oct 8, 1:02 PM PDT'],
  ['2026-10-08T20:02:00Z', 'short', 'Oct 8, 1:02 PM PDT'],
  ['2026-12-01T08:05:00Z', 'short', 'Dec 1, 12:05 AM PST'],
  ['2026-11-01T08:30:00Z', 'short', 'Nov 1, 1:30 AM PDT'],
  ['2026-11-01T09:30:00Z', 'short', 'Nov 1, 1:30 AM PST'],
  [null, 'short', ''],
  ['not a date', 'short', ''],
]) {
  test(`formatPacific(${iso}, ${style}) → ${JSON.stringify(want)}`, () => {
    assert.equal(formatPacific(iso, style), want);
  });
}

// ---- shippedBefore -------------------------------------------------------

const leaf = (n, extra = {}) => ({ ref: R(n), title: `T${n}`, url: `u${n}`, state: 'CLOSED', stateReason: 'COMPLETED', closedAt: `2026-09-0${n}T20:00:00Z`, ...extra });
const epic = (n, leaves) => ({ ref: R(n), url: `u${n}`, title: `Epic ${n}`, leaves });

for (const [name, groups, exclude, want] of [
  ['closed leaves are shipped, newest first', [epic(1, [leaf(2), leaf(4), leaf(3)])], [], [{ shipped: [R(4), R(3), R(2)], dropped: 0 }]],
  ['closed as not planned is dropped, not shipped', [epic(1, [leaf(2), leaf(3, { stateReason: 'NOT_PLANNED' })])], [], [{ shipped: [R(2)], dropped: 1 }]],
  ['closed as a duplicate is dropped, not shipped', [epic(1, [leaf(2), leaf(3, { stateReason: 'DUPLICATE' })])], [], [{ shipped: [R(2)], dropped: 1 }]],
  ['an open leaf is neither', [epic(1, [leaf(2), leaf(3, { state: 'OPEN', stateReason: null, closedAt: null })])], [], [{ shipped: [R(2)], dropped: 0 }]],
  ['a ticket of the run itself is left out', [epic(1, [leaf(2), leaf(3)])], [R(3)], [{ shipped: [R(2)], dropped: 0 }]],
  ['a leaf under two epics counts once, under the first', [epic(1, [leaf(2)]), epic(5, [leaf(2), leaf(3)])], [], [{ shipped: [R(2)], dropped: 0 }, { shipped: [R(3)], dropped: 0 }]],
  ['an epic with no leaves is kept, empty', [epic(1, [])], [], [{ shipped: [], dropped: 0 }]],
]) {
  test(`shippedBefore: ${name}`, () => {
    const got = shippedBefore(groups, exclude);
    assert.deepEqual(got.map((g) => ({ shipped: g.shipped.map((l) => l.ref), dropped: g.dropped })), want);
    assert.deepEqual(got.map((g) => [g.ref, g.url, g.title]), groups.map((g) => [g.ref, g.url, g.title]));
  });
}

for (const [reason, want] of [['NOT_PLANNED', 'dropped'], ['DUPLICATE', 'dropped'], ['COMPLETED', 'shipped'], [null, 'shipped']]) {
  test(`closedKind(${reason}) is ${want}`, () => assert.equal(closedKind(reason), want));
}
