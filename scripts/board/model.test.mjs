// Tests for the status board's pure model. Run: node --test scripts/board/
//
// Every function here is pure, so each is pinned by a table of small graphs
// written as edge lists: `[blocker, blocked]` pairs over short refs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify, buildGraph, orderSteps, projectWaves, leadingWaveNumber, makeShortRef, makeRepoLabel, formatPacific, compareRefs, shippedBefore, closedKind, milestones, roadTo,
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

// An open blocker outside the run that the closure read joins the node set as an `outside` ref: it gets a step and
// what waits on it follows (issue #515).
test('buildGraph with outside places the blocker and its dependents in steps (issue #515)', () => {
  // 9 (outside) → 2 → 3, and 4 stands alone.
  const g = buildGraph([2, 3, 4].map(R), edgesOf([[9, 2], [2, 3]]), [], { outside: [R(9)] });
  assert.deepEqual(g.steps, [[R(4), R(9)], [R(2)], [R(3)]]);
  assert.equal(g.stepOf.get(R(9)), 0);
  assert.equal(g.stepOf.get(R(3)), 2);
  assert.deepEqual([...g.outside], [R(9)]);
  assert.deepEqual([...g.unorderable], []);
  assert.deepEqual([...g.preds.get(R(2))], [R(9)], 'the edge from an outside node is drawn');
  assert.deepEqual([...g.descendants.get(R(9))].sort(), [R(2), R(3)]);
  assert.deepEqual(g.chain, [R(9), R(2), R(3)]);
});

test('buildGraph with outside keeps today\'s result when outside is empty or absent (issue #515)', () => {
  const g = buildGraph([R(2)], edgesOf([[1, 2]]), [], { outside: [] });
  assert.deepEqual([...g.unorderable], [R(2)]);
  assert.deepEqual([...g.outside], []);
  assert.deepEqual([...buildGraph([R(2)], edgesOf([[1, 2]]), []).outside], []);
});

test('buildGraph keeps an outside blocker behind an unread open ref unorderable, and what waits on it (issue #515)', () => {
  // 8 is open and was never read; 9 (outside) waits on it; 2 waits on 9.
  const g = buildGraph([2, 4].map(R), edgesOf([[8, 9], [9, 2]]), [], { outside: [R(9)] });
  assert.deepEqual(g.steps, [[R(4)]]);
  assert.deepEqual([...g.unorderable].sort(), [R(2), R(9)]);
});

test('buildGraph keeps a cycle through an outside node unorderable (issue #515)', () => {
  const g = buildGraph([2, 4].map(R), edgesOf([[9, 2], [2, 9]]), [], { outside: [R(9)] });
  assert.deepEqual(g.steps, [[R(4)]]);
  assert.deepEqual([...g.unorderable].sort(), [R(2), R(9)]);
});

test('buildGraph reads an outside ref that is closed as done, and one that is also a run ticket as the run\'s (issue #515)', () => {
  const g = buildGraph([R(2), R(3)], edgesOf([[9, 2], [2, 3]]), [R(9)], { outside: [R(9), R(2)] });
  assert.deepEqual(g.steps, [[R(2)], [R(3)]]);
  assert.deepEqual([...g.outside], []);
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

// An outside node is one wave of its home run: the current wave when nothing open precedes it, else one after its
// blockers; the run ticket behind it is one after that (issue #515).
test('projectWaves: outside nodes cost a wave each along a chain, and carry no label (issue #515)', () => {
  // 8 (outside) → 9 (outside) → 2 (ours); the current wave is 5.
  const g = buildGraph([R(2)], edgesOf([[8, 9], [9, 2]]), [], { outside: [R(8), R(9)] });
  const w = projectWaves(g, new Map([[R(2), 'blocked']]), { id: '5', refs: new Set() });
  assert.deepEqual(w.get(R(8)), { label: null, now: false, outside: true });
  assert.deepEqual(w.get(R(9)), { label: null, now: false, outside: true });
  assert.deepEqual(w.get(R(2)), { label: '7', now: false }, 'cur, cur + 1, then cur + 2');
});

test('projectWaves: a root outside node sits in the current wave, so its dependent is one after it (issue #515)', () => {
  const g = buildGraph([R(2), R(3)], edgesOf([[9, 3]]), [], { outside: [R(9)] });
  const w = projectWaves(g, new Map([[R(2), 'ready'], [R(3), 'blocked']]), { id: '5', refs: new Set() });
  assert.equal(w.get(R(2)).label, '6');
  assert.equal(w.get(R(3)).label, '6', 'cur is 5 for the outside root, so its dependent is 6');
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

test('the close-reason table is not exported, so importers cannot mutate it', async () => {
  const state = await import('../eta/state.mjs');
  assert.equal(state.CLOSED_UNDONE, undefined);
  assert.equal(state.isClosedUndone('DUPLICATE'), true);
  assert.equal(state.isClosedUndone('COMPLETED'), false);
});

// ---- milestones / roadTo (issue #518) ------------------------------------

/**
 * A run for the milestone tests: 1 shipped, 2 → 3 → 4 open in a chain, 5 open behind outside 8, 6 dropped, 7 in a
 * self-cycle. `labels` maps a ticket number to its labels; `notes` is board-notes' `milestones`.
 */
function msRun({ labels = {}, notes, closedAt = {} } = {}) {
  const status = { 1: 'shipped', 2: 'ready', 3: 'blocked', 4: 'blocked', 5: 'blocked', 6: 'dropped', 7: 'blocked', 9: 'shipped' };
  const tickets = Object.entries(status).map(([n, s]) => ({
    ref: R(n), title: `Ticket ${n}`, status: s, labels: labels[n] ?? [], closedAt: closedAt[n] ?? (s === 'shipped' ? `2026-10-0${n}T12:00:00Z` : null), shippedWave: s === 'shipped' ? String(n) : undefined,
  }));
  const open = tickets.filter((t) => !['shipped', 'dropped'].includes(t.status)).map((t) => t.ref);
  const graph = buildGraph(open, edgesOf([[2, 3], [3, 4], [8, 5], [7, 7]]), [R(1), R(6), R(9)], { outside: [R(8)] });
  const waves = projectWaves(graph, new Map(tickets.map((t) => [t.ref, t.status])), { id: '4', refs: new Set([R(2)]) });
  return { tickets, graph, waves, notes: notes === undefined ? {} : { milestones: notes } };
}
const names = (rows) => rows.map((m) => [m.ref, m.name]);

for (const [name, opts, want] of [
  ['a hitl-gate ticket is a milestone named by its title', { labels: { 4: ['hitl-gate'] } }, [[R(4), 'Ticket 4']]],
  ['a notes string renames an automatic milestone', { labels: { 4: ['enhancement', 'hitl-gate'] }, notes: { [R(4)]: 'First listen' } }, [[R(4), 'First listen']]],
  ['a notes string adds a ticket that is not a gate', { notes: { [R(3)]: 'Trace tool' } }, [[R(3), 'Trace tool']]],
  ['false suppresses an automatic milestone', { labels: { 4: ['hitl-gate'] }, notes: { [R(4)]: false } }, []],
  ['a value that is neither a non-empty string nor false is ignored', { labels: { 4: ['hitl-gate'] }, notes: { [R(4)]: '  ', [R(3)]: 7, [R(2)]: null } }, [[R(4), 'Ticket 4']]],
  ['a dropped ticket is never a milestone', { labels: { 6: ['hitl-gate'] }, notes: { [R(6)]: 'Gone' } }, []],
  ['a notes key outside the run names nothing', { notes: { [R(99)]: 'Nowhere' } }, []],
  ['a label is matched exactly', { labels: { 4: ['HITL-gate', 'hitl-gates'] } }, []],
]) {
  test(`milestones: ${name}`, () => {
    assert.deepEqual(names(milestones(msRun(opts))), want);
  });
}

test('milestones: before counts the open run tickets ahead of it, outside names the outside ones, and the wave is projected', () => {
  const rows = milestones(msRun({ labels: { 3: ['hitl-gate'], 4: ['hitl-gate'], 5: ['hitl-gate'] } }));
  const by = Object.fromEntries(rows.map((m) => [m.ref, m]));
  assert.deepEqual([by[R(4)].before, by[R(4)].outside], [2, []]);
  assert.deepEqual([by[R(3)].before, by[R(3)].outside], [1, []]);
  assert.deepEqual([by[R(5)].before, by[R(5)].outside], [0, [R(8)]], 'an outside blocker is named, never counted');
  assert.deepEqual(by[R(4)].wave, { label: '6', now: false });
  assert.equal(by[R(4)].state, 'open');
});

test('milestones: reached rows first by closedAt, then open ones in step order, then unorderable ones; next is the first open orderable row', () => {
  const rows = milestones(msRun({ labels: { 1: ['hitl-gate'], 9: ['hitl-gate'], 4: ['hitl-gate'], 3: ['hitl-gate'], 7: ['hitl-gate'] }, closedAt: { 1: '2026-10-05T00:00:00Z', 9: '2026-10-02T00:00:00Z' } }));
  assert.deepEqual(rows.map((m) => [m.ref, m.state]), [[R(9), 'reached'], [R(1), 'reached'], [R(3), 'open'], [R(4), 'open'], [R(7), 'unorderable']]);
  assert.deepEqual(rows.filter((m) => m.next).map((m) => m.ref), [R(3)], 'exactly one next');
  assert.deepEqual(rows[0].wave, { label: '9', now: false }, 'a reached milestone shows the wave it shipped in');
});

test('milestones: no row is next when every milestone is reached or unorderable', () => {
  const rows = milestones(msRun({ labels: { 1: ['hitl-gate'], 7: ['hitl-gate'] } }));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((m) => !m.next));
});

test('milestones: no notes and no labels is no rows', () => {
  const run = msRun();
  delete run.notes;
  run.tickets.forEach((t) => { delete t.labels; });
  assert.deepEqual(milestones(run), []);
});

test('roadTo is the milestone and its ancestors, outside nodes included; empty for null or an unorderable ref', () => {
  const { graph } = msRun();
  assert.deepEqual([...roadTo(graph, R(4))].sort(compareRefs), [R(2), R(3), R(4)]);
  assert.deepEqual([...roadTo(graph, R(5))].sort(compareRefs), [R(5), R(8)]);
  assert.equal(roadTo(graph, null).size, 0);
  assert.equal(roadTo(graph, R(7)).size, 0);
});

/**
 * A run where ref order and step order disagree: #12 and #14 start now (step 1); #11 waits on #12 (step 2);
 * #10 waits on #12 and #14 (step 2, one more ancestor than #11). Every ticket but #13 is a milestone.
 */
function reversedRun(labelled = [10, 11, 12, 14]) {
  const nums = [10, 11, 12, 14];
  const tickets = nums.map((n) => ({ ref: R(n), title: `Ticket ${n}`, status: n >= 12 ? 'ready' : 'blocked', labels: labelled.includes(n) ? ['hitl-gate'] : [] }));
  const graph = buildGraph(nums.map(R), edgesOf([[12, 11], [12, 10], [14, 10]]), []);
  const waves = projectWaves(graph, new Map(tickets.map((t) => [t.ref, t.status])), { id: '3', refs: new Set([R(12)]) });
  return { tickets, graph, waves };
}

test('milestones: open rows are in step order, then fewest tickets before them, then ref order (issue #518)', () => {
  const rows = milestones(reversedRun());
  // #12, #14: step 1 (ref order); #11 (1 ticket before it) beats #10 (2) though #10 sorts first by ref.
  assert.deepEqual(rows.map((m) => m.ref), [R(12), R(14), R(11), R(10)]);
  assert.deepEqual(rows.filter((m) => m.next).map((m) => m.ref), [R(12)]);
});

test('milestones: next is the earliest step, not the lowest ref, and the road to it is its own ancestry (issue #518)', () => {
  const run = reversedRun([11, 12]);
  const rows = milestones(run);
  assert.deepEqual(rows.map((m) => m.ref), [R(12), R(11)], '#11 sorts first by ref, but #12 comes first in the run');
  assert.equal(rows.find((m) => m.next).ref, R(12));
  assert.deepEqual([...roadTo(run.graph, rows.find((m) => m.next).ref)], [R(12)]);
});

test('milestones: a named milestone is stored trimmed (issue #518)', () => {
  const rows = milestones({ ...msRun({ notes: { [R(3)]: '  Trace tool \n' } }) });
  assert.deepEqual(names(rows), [[R(3), 'Trace tool']]);
});
