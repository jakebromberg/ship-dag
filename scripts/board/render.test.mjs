// Tests for the status board renderer. The page is checked structurally — the
// sections a reader relies on are present, every string is escaped, and every
// time is Pacific with its zone — not byte-for-byte, so styling can move freely.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, projectWaves, makeShortRef, makeRepoLabel, classify } from './model.mjs';
import { renderBoard, STATUSES, waveSpan } from './render.mjs';
import { PAGE_CSS } from './assets.mjs';

const R = (n) => `o/r#${n}`;
const ticket = (n, status, extra = {}) => ({
  ref: R(n), title: `Ticket ${n}`, url: `https://github.com/o/r/issues/${n}`, status, prs: [], ...extra,
});

/** A small run: one shipped, one in flight (wave 4b), one waiting on it, one ready, one dropped, two in a cycle. */
function view(over = {}) {
  const tickets = [
    ticket(1, 'shipped', { closedAt: '2026-10-08T20:02:00Z', shippedWave: '3', prs: [{ number: 11, url: 'u11', state: 'merged' }] }),
    ticket(2, 'flight', { stage: 'Reviewed', note: 'One nit left.', prs: [{ number: 12, url: 'u12', state: 'open' }] }),
    ticket(3, 'blocked'),
    ticket(4, 'ready'),
    ticket(5, 'dropped', { closedAt: '2026-10-01T18:00:00Z' }),
    ticket(6, 'blocked'),
    ticket(7, 'blocked'),
  ];
  const open = tickets.filter((t) => !['shipped', 'dropped'].includes(t.status)).map((t) => t.ref);
  const closed = tickets.filter((t) => ['shipped', 'dropped'].includes(t.status)).map((t) => t.ref);
  const graph = buildGraph(open, [
    { blockedBy: R(1), blocked: R(4) }, { blockedBy: R(2), blocked: R(3) }, { blockedBy: R(6), blocked: R(7) }, { blockedBy: R(7), blocked: R(6) },
  ], closed);
  const current = { id: '4b', refs: new Set([R(2)]) };
  const status = new Map(tickets.map((t) => [t.ref, t.status]));
  return {
    title: 'Example ship status',
    runId: 'sd-20261008-120000',
    scope: { url: 'https://github.com/o/r/issues/100', label: 'Epic r#100', title: 'The epic' },
    now: '2026-10-08T20:30:00Z',
    tickets,
    graph,
    current,
    waves: projectWaves(graph, status, current),
    shortRef: makeShortRef(['o/r']),
    repoLabel: makeRepoLabel(['o/r']),
    notes: { callouts: [{ owner: 'you', title: 'Pick a rule', text: 'Two places disagree.' }] },
    rebuild: 'node scripts/board.mjs render --run-id sd-20261008-120000',
    ...over,
  };
}

test('renderBoard emits every section a reader relies on', () => {
  const html = renderBoard(view());
  for (const heading of ['Needs attention', 'In flight', 'Road ahead', 'Shipped', "Can't be ordered", 'Closed as not planned']) {
    assert.ok(html.includes(heading), `missing section: ${heading}`);
  }
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Example ship status<\/title>/);
});

test('renderBoard shows counts, the in-flight stage and note, and the wave building now', () => {
  const html = renderBoard(view());
  assert.match(html, /<b>1\/6<\/b><span>shipped<\/span>/, 'dropped tickets are left out of the total');
  assert.match(html, /Reviewed<\/span>/);
  assert.match(html, /One nit left\./);
  assert.match(html, /Wave 4b · building now/);
  // Ticket #4 is ready and also projects to wave 5, so the match is bounded to #3's own node.
  assert.match(html, /data-ref="o\/r#3"(?:(?!data-ref)[\s\S])*?Wave 5</, 'the ticket waiting on wave 4b projects to wave 5');
});

test('renderBoard ships each edge once and no per-node ancestor or descendant sets', () => {
  const html = renderBoard(view());
  assert.match(html, /id="dag" data-edges="\[\[&quot;o\/r#2&quot;,&quot;o\/r#3&quot;,(?:true|false)\]/);
  assert.doesNotMatch(html, /data-anc|data-desc/);
});

test('renderBoard lists cyclic tickets in the callout, not in the road ahead', () => {
  const html = renderBoard(view());
  const callout = html.slice(html.indexOf("Can't be ordered"));
  assert.ok(callout.includes('r#6') && callout.includes('r#7'));
  assert.ok(!html.includes('data-ref="o/r#6"'), 'a cyclic ticket gets no node in the step layout');
});

test('renderBoard escapes every interpolated string, callouts included', () => {
  const evil = '<script>alert(1)</script>';
  const v = view();
  v.tickets[3] = { ...v.tickets[3], title: evil };
  v.notes = { callouts: [{ title: evil, text: evil }], wave: evil };
  const html = renderBoard({ ...v, title: evil });
  assert.ok(!html.includes(evil), 'no raw markup survives');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('renderBoard shows every time in Pacific with its zone, never UTC', () => {
  const html = renderBoard(view());
  assert.match(html, /Updated Thu Oct 8, 1:30 PM PDT/);
  assert.match(html, /Oct 8, 1:02 PM PDT/, 'shipped close time');
  assert.ok(!/UTC|GMT|Z"/.test(html.replace(/<script>[\s\S]*<\/script>/, '')), 'no UTC anywhere on the page');
});

test('renderBoard names the command that rebuilds it and says nothing is committed', () => {
  const html = renderBoard(view());
  assert.match(html, /node scripts\/board\.mjs render --run-id sd-20261008-120000/);
  assert.match(html, /Local file, not committed/);
});

test('renderBoard with nothing open says so', () => {
  const v = view();
  const tickets = v.tickets.filter((t) => t.status === 'shipped');
  const graph = buildGraph([], [], []);
  const html = renderBoard({ ...v, tickets, graph, waves: new Map(), current: null });
  assert.match(html, /Nothing left open\./);
  assert.match(html, /No PR open right now\./);
});

test('renderBoard with tickets left but none orderable says so, not that nothing is open', () => {
  const v = view();
  const tickets = v.tickets.filter((t) => [6, 7].includes(Number(t.ref.split('#')[1])));
  const graph = buildGraph([R(6), R(7)], [{ blockedBy: R(6), blocked: R(7) }, { blockedBy: R(7), blocked: R(6) }], []);
  const html = renderBoard({ ...v, tickets, graph, waves: new Map(), current: null });
  assert.match(html, /Nothing can be ordered\./);
  assert.doesNotMatch(html, /Nothing left open/);
});

test('renderBoard counts one ticket and one step in the singular', () => {
  const v = view();
  const tickets = [ticket(1, 'shipped', { closedAt: '2026-10-08T20:02:00Z' }), ticket(4, 'ready')];
  const graph = buildGraph([R(4)], [], [R(1)]);
  const html = renderBoard({ ...v, tickets, graph, waves: projectWaves(graph, new Map([[R(4), 'ready']]), null), current: null });
  assert.match(html, /1 ticket left, in 1 step\./);
  assert.match(html, /\(1 ticket, one after another\)/);
  assert.match(html, /Shipped <small>1 ticket, newest first/);
});

// The summary counts every open ticket, so it can't disagree with the "Can't be ordered" callout.
test('renderBoard counts unorderable tickets in the road-ahead summary', () => {
  const v = view();
  const tickets = [ticket(3, 'ready'), ticket(4, 'ready'), ticket(6, 'blocked'), ticket(7, 'blocked')];
  const graph = buildGraph(tickets.map((t) => t.ref), [{ blockedBy: R(6), blocked: R(7) }, { blockedBy: R(7), blocked: R(6) }], []);
  const html = renderBoard({ ...v, tickets, graph, waves: new Map(), current: null });
  assert.match(html, /<b>4 tickets left: 2 in 1 step, 2 can't be ordered\.<\/b>/);
});

test('renderBoard labels an in-flight card with no stage by its STATUSES chip', () => {
  const v = view();
  const tickets = [ticket(9, 'flight')];
  const html = renderBoard({ ...v, tickets, graph: buildGraph([R(9)], [], []), waves: new Map(), current: null });
  const { chip } = STATUSES.find((s) => s.status === 'flight');
  assert.ok(html.slice(html.indexOf('In flight'), html.indexOf('Road ahead')).includes(`<span class="chip c-flight">${chip}</span>`));
});

// A chip's colour follows its word: a stage reads the same in the in-flight cards and the road ahead, whatever
// the ticket's status, so a Stalled ticket is never the colour of a Ready one.
for (const [stage, status] of [
  ['Building', 'flight'], ['In review', 'flight'], ['Reviewed', 'flight'], ['Fixing', 'flight'],
  ['Stalled', 'you'], ['Review unreadable', 'you'],
]) {
  test(`a ${stage} chip wears the ${status} colour in every section`, () => {
    const v = view();
    const tickets = [ticket(9, 'flight', { stage }), ticket(10, 'ready', { stage })];
    const html = renderBoard({ ...v, tickets, graph: buildGraph([R(9), R(10)], [], []), waves: new Map(), current: null });
    const classes = [...html.matchAll(new RegExp(`<span class="chip (c-[a-z]+)">${stage}</span>`, 'g'))].map((m) => m[1]);
    assert.equal(classes.length, 3, 'the in-flight card and both road-ahead nodes');
    assert.deepEqual([...new Set(classes)], [`c-${status}`]);
  });
}

test('a stage the board does not know keeps the ticket\'s status colour', () => {
  const v = view();
  const tickets = [ticket(10, 'ready', { stage: 'Merged' })];
  const html = renderBoard({ ...v, tickets, graph: buildGraph([R(10)], [], []), waves: new Map(), current: null });
  assert.ok(html.includes('<span class="chip c-ready">Merged</span>'));
});

test('renderBoard sorts refs numerically within a repo: #9 before #10', () => {
  const v = view();
  const tickets = [ticket(10, 'flight'), ticket(9, 'flight'), ticket(20, 'blocked'), ticket(19, 'blocked')];
  const graph = buildGraph([R(10), R(9), R(20), R(19)], [{ blockedBy: R(19), blocked: R(20) }, { blockedBy: R(20), blocked: R(19) }], []);
  const html = renderBoard({ ...v, tickets, graph, waves: new Map(), current: null });
  const cards = html.slice(html.indexOf('In flight'), html.indexOf('Road ahead'));
  assert.ok(cards.indexOf('r#9<') < cards.indexOf('r#10<'), 'in-flight cards');
  const callout = html.slice(html.indexOf("Can't be ordered"));
  assert.ok(callout.indexOf('r#19<') < callout.indexOf('r#20<'), 'unorderable list');
});

test('renderBoard labels each repo bar as the refs label it, so same-named repos stay apart', () => {
  const v = view();
  const repos = ['a/web', 'b/web'];
  const tickets = [{ ...ticket(1, 'ready'), ref: 'a/web#1' }, { ...ticket(2, 'ready'), ref: 'b/web#2' }];
  const graph = buildGraph(tickets.map((t) => t.ref), [], []);
  const html = renderBoard({ ...v, tickets, graph, waves: new Map(), current: null,
    shortRef: makeShortRef(repos), repoLabel: makeRepoLabel(repos) });
  assert.match(html, /<b>a\/web<\/b> · /);
  assert.match(html, /<b>b\/web<\/b> · /);
});

test('renderBoard reads only a callout\'s text', () => {
  const html = renderBoard(view({ notes: { callouts: [{ title: 'T', html: 'only-in-html' }] } }));
  assert.ok(!html.includes('only-in-html'));
});

for (const [labels, want] of [
  [['9', '10'], 'waves 9–10'],
  [['10', '9', '31b', '31'], 'waves 9–31b'],
  [['4b'], 'wave 4b'],
]) {
  test(`waveSpan(${JSON.stringify(labels)}) is ${want}`, () => assert.equal(waveSpan(labels), want));
}

test('every status classify() can return has a STATUSES entry', () => {
  const seen = new Set();
  for (const state of ['OPEN', 'CLOSED']) for (const stateReason of [null, 'NOT_PLANNED']) {
    for (const hasOpenPr of [false, true]) for (const owned of [false, true]) for (const openBlockers of [0, 1]) {
      seen.add(classify({ state, stateReason, hasOpenPr, owned, openBlockers }));
    }
  }
  assert.deepEqual([...seen].filter((s) => !STATUSES.some((e) => e.status === s)), []);
});

for (const { status, token } of STATUSES) {
  test(`the ${status} chip is styled in its legend colour, --${token}`, () => {
    const rule = [...PAGE_CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, sel]) => sel.split(',').some((x) => x.trim() === `.c-${status}`));
    assert.equal(rule?.[2], `color:var(--${token});background:var(--${token}-bg)`);
  });
}
