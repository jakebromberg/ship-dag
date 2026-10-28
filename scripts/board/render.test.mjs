// Tests for the status board renderer. The page is checked structurally — the
// sections a reader relies on are present, every string is escaped, and every
// time is Pacific with its zone — not byte-for-byte, so styling can move freely.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, projectWaves, makeShortRef, makeRepoLabel, classify, milestones } from './model.mjs';
import { renderBoard, STATUSES, stageStatus, waveSpan } from './render.mjs';
import * as render from './render.mjs';
import { STAGES } from './stage.mjs';
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
  for (const heading of ['Needs attention', 'In flight', 'Road ahead', 'Shipped', "Can't be ordered", 'Closed without shipping']) {
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
  [STAGES.building, 'flight'], [STAGES.inReview, 'flight'], [STAGES.reviewed, 'flight'], [STAGES.fixing, 'flight'],
  [STAGES.stalled, 'you'], [STAGES.unreadable, 'you'],
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

test('every engine stage label has a chip colour', () => {
  for (const stage of Object.values(STAGES)) {
    assert.ok(STATUSES.some((s) => s.status === stageStatus(stage)), `${stage} has no stageStatus entry`);
  }
});

test('the stage-to-status table is not exported, so importers cannot mutate it', () => {
  assert.equal(render.STAGE_STATUS, undefined);
  assert.equal(stageStatus('not a stage'), undefined);
});

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

// ---- outside blockers (issue #515) ----------------------------------------

const O = (n) => `x/y#${n}`;
const outsideTicket = (n) => ({ ref: O(n), title: `Outside ${n}`, url: `https://github.com/x/y/issues/${n}` });

/** Two outside blockers in a chain ahead of our tickets: O90 → O91 → r#2 → r#3, with r#4 ready beside O90. */
function outsideView(over = {}) {
  const tickets = [ticket(2, 'blocked'), ticket(3, 'blocked'), ticket(4, 'ready')];
  const outside = [O(90), O(91)];
  const graph = buildGraph(tickets.map((t) => t.ref), [
    { blockedBy: O(90), blocked: O(91) }, { blockedBy: O(91), blocked: R(2) }, { blockedBy: R(2), blocked: R(3) },
  ], [], { outside });
  const current = { id: '4b', refs: new Set([R(4)]) };
  return {
    ...view(), tickets, graph, current, outsideTickets: outside.map((r) => outsideTicket(Number(r.split('#')[1]))),
    waves: projectWaves(graph, new Map(tickets.map((t) => [t.ref, t.status])), current),
    shortRef: makeShortRef(['o/r', 'x/y']), repoLabel: makeRepoLabel(['o/r', 'x/y']), notes: {}, ...over,
  };
}

/** The markup of the node for `ref`: from its opening tag to the next node's (or the end of the step layout). */
function nodeOf(html, ref) {
  const at = html.indexOf(`data-ref="${ref}"`);
  assert.notEqual(at, -1, `no node for ${ref}`);
  const next = html.indexOf('data-ref=', at + 1);
  return html.slice(at, next === -1 ? html.indexOf('</details>', at) : next);
}

test('renderBoard draws an outside blocker as a node: s-outside, an Outside chip, "Outside this run" and its real link (issue #515)', () => {
  const html = renderBoard(outsideView());
  const node = nodeOf(html, O(90));
  assert.match(html, /<div class="node s-outside[ "][^>]*data-ref="x\/y#90"/);
  assert.ok(node.includes('<span class="chip c-outside">Outside</span>'), node);
  assert.ok(node.includes('Outside this run'));
  assert.ok(node.includes('href="https://github.com/x/y/issues/90"'));
  assert.doesNotMatch(html, /c-undefined|s-undefined/);
  const chain = html.slice(html.indexOf('Longest chain:'), html.indexOf('Lines show direct'));
  assert.ok(chain.includes('href="https://github.com/x/y/issues/90"'), 'the longest-chain bar links it');
  const table = html.slice(html.indexOf('Order of work as a table'));
  assert.ok(table.includes('href="https://github.com/x/y/issues/90"'), 'the table links it');
  assert.ok(!html.includes('href=""'), 'no link is left without a target');
});

test('renderBoard shows an outside blocker\'s title in its node and in the table (issue #515)', () => {
  const html = renderBoard(outsideView());
  assert.ok(nodeOf(html, O(90)).includes('title="Outside 90">Outside 90</div>'));
  assert.match(html.slice(html.indexOf('Order of work as a table')), /<td>Outside 91<\/td>/);
});

test('renderBoard labels a step of only outside nodes "outside this run" and a mixed step "+ outside" (issue #515)', () => {
  const html = renderBoard(outsideView());
  const labels = [...html.matchAll(/<span class="wv">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['wave 4b + outside', 'outside this run', 'wave 6', 'wave 7'], 'step 1 holds ready r#4 (wave 4b) beside O90; step 2 only O91');
});

test('renderBoard counts the outside tickets in the road summary\'s total and names them apart, and splits the chain label (issues #515, #522)', () => {
  const html = renderBoard(outsideView());
  assert.match(html, /<b>5 tickets left: 3 in this run, 2 outside it; in 4 steps\.<\/b>/);
  assert.match(html, /\(4 tickets, one after another: 2 in this run, 2 outside\)/);
});

test('renderBoard pins the combined unorderable-plus-outside summary (issue #515)', () => {
  const v = outsideView();
  const tickets = [ticket(2, 'blocked'), ticket(3, 'ready'), ticket(4, 'ready'), ticket(6, 'blocked'), ticket(7, 'blocked')];
  const graph = buildGraph(tickets.map((t) => t.ref), [
    { blockedBy: O(90), blocked: R(2) }, { blockedBy: R(6), blocked: R(7) }, { blockedBy: R(7), blocked: R(6) },
  ], [], { outside: [O(90)] });
  const html = renderBoard({ ...v, tickets, graph, waves: new Map() });
  assert.match(html, /<b>6 tickets left: 5 in this run, 1 outside it; 4 in 2 steps, 2 can't be ordered\.<\/b>/);
});

test('renderBoard counts only our tickets under "unblocks", in the node and in the table (issue #515)', () => {
  const html = renderBoard(outsideView());
  assert.ok(nodeOf(html, O(90)).includes('unblocks 2'), 'r#2 and r#3, not O91');
  const row = html.slice(html.indexOf('Order of work as a table')).split('<tr>').find((r) => r.includes('issues/90'));
  assert.match(row, /<td class="n">2<\/td><\/tr>/, 'the table\'s Unblocks column');
});

test('renderBoard writes "outside" in the table\'s Wave column (issue #515)', () => {
  const html = renderBoard(outsideView());
  const row = html.slice(html.indexOf('Order of work as a table')).split('<tr>').find((r) => r.includes('issues/90'));
  assert.match(row, /^<td class="n">1<\/td><td class="n">outside<\/td>/);
});

test('renderBoard\'s how-to and callout say what an Outside node is and what stays unplaced (issue #515)', () => {
  assert.match(renderBoard(outsideView()), /A dashed Outside node is an open issue owned by another run; the waves after it assume that run/);
  assert.match(renderBoard(view()), /outside this run that the board could not place \(never read, or caught in a cycle\)/);
});

test('renderBoard has no "Can\'t be ordered" callout when everything was placed (issue #515)', () => {
  assert.doesNotMatch(renderBoard(outsideView()), /Can't be ordered/);
});

test('renderBoard leaves today\'s summary, chain strings, tiles and legend alone when nothing is outside (issues #515, #522)', () => {
  const html = renderBoard(view());
  assert.doesNotMatch(html, /outside it|outside this run<\/span>/);
  assert.doesNotMatch(html, /Open outside this run|open outside this run/);
  assert.doesNotMatch(html, /one after another:/);
});

test('renderBoard counts the required set: open outside tickets get a tile, legend entry and bar segment, shipped ones join Shipped, marked (issue #522)', () => {
  const v = outsideView();
  const shippedOut = { ref: O(80), title: 'Done elsewhere', url: 'https://github.com/x/y/issues/80', status: 'shipped', closedAt: '2026-10-08T19:00:00Z', prs: [{ number: 81, url: 'u81', state: 'merged' }] };
  const html = renderBoard({ ...v, outsideTickets: [...v.outsideTickets, shippedOut] });
  assert.match(html, /<b>1\/6<\/b><span>shipped<\/span>/, 'three run tickets, two open outside, one shipped outside');
  assert.match(html, /<b>2<\/b><span>open outside this run<\/span>/);
  assert.match(html, /<span><i style="background:var\(--outside\)"><\/i>Open outside this run<\/span>/);
  assert.match(html, /<i style="flex:2;background:var\(--outside\)"><\/i>/);
  assert.match(html, /<b>y<\/b> · 1\/3 shipped/, 'the outside repo gets a bar of its own');
  const shipped = html.slice(html.indexOf('<h2>Shipped'));
  assert.match(shipped, /<small>1 ticket, newest first/);
  assert.match(shipped, /<td>Done elsewhere <span class="owner">outside this run<\/span><\/td><td class="n"><a class="pr pr-merged" href="u81"/);
});

// ---- predecessor epics ---------------------------------------------------

const before = (epicRef, leaves, dropped = 0) => ({ ref: epicRef, url: 'https://github.com/o/r/issues/50', title: 'The first epic', dropped,
  shipped: leaves.map((n) => ({ ref: R(n), title: `Earlier ${n}`, url: `https://github.com/o/r/issues/${n}`, closedAt: '2026-09-02T19:00:00Z' })) });

test('renderBoard adds a collapsed "Shipped before this run" section below Shipped, with the epic link, count, and each leaf\'s Pacific close time', () => {
  const html = renderBoard(view({ before: [before(R(50), [60, 61, 62], 2)] }));
  assert.ok(html.indexOf('Shipped before this run') > html.indexOf('Show all 1'), 'below the run\'s own Shipped section');
  const section = html.slice(html.indexOf('<details><summary>Shipped before this run'));
  assert.match(section, /^<details><summary>Shipped before this run: <a href="https:\/\/github.com\/o\/r\/issues\/50">r#50<\/a> — The first epic \(3, plus 2 closed without shipping\)<\/summary>/);
  assert.ok(!section.slice(0, 40).includes('open'), 'collapsed: no open attribute');
  for (const n of [60, 61, 62]) { assert.ok(section.includes(`<a href="https://github.com/o/r/issues/${n}">r#${n}</a>`) && section.includes(`Earlier ${n}`)); }
  assert.match(section, /Sep 2, 12:00 PM PDT/);
});

test('renderBoard\'s headline counts both: the tile, its label and the bar', () => {
  const html = renderBoard(view({ before: [before(R(50), [60, 61]), before(R(51), [62])] }));
  assert.match(html, /<b>4\/9<\/b><span>shipped \(3 before this run\)<\/span>/, 'the run\'s 1 + 3 earlier, of 6 + 3');
  assert.match(html, /aria-label="4 of 9 shipped"/);
  assert.match(html, /Shipped <small>1 ticket, newest first/, 'the run\'s own Shipped section is unchanged');
});

test('renderBoard without predecessors is unchanged: no section, the plain tile', () => {
  for (const html of [renderBoard(view()), renderBoard(view({ before: [] }))]) {
    assert.ok(!html.includes('before this run'));
    assert.match(html, /<b>1\/6<\/b><span>shipped<\/span>/);
  }
});

test('renderBoard escapes a predecessor\'s title', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const b = before(R(50), [60]);
  const html = renderBoard(view({ before: [{ ...b, title: evil, shipped: [{ ...b.shipped[0], title: evil }] }] }));
  assert.ok(!html.includes(evil));
});

// ---- burn-up chart ---------------------------------------------------------

const STARTED = '2026-10-08T12:00:00Z'; // 5 AM PDT; the view's now is 1:30 PM PDT
const chart = (html) => html.slice(html.indexOf('<section class="burn"'), html.indexOf('</section>') + 10);

test('renderBoard puts the burn-up under the headline counts, above Needs attention and In flight', () => {
  const html = renderBoard(view({ startedAt: STARTED }));
  const at = html.indexOf('<section class="burn"');
  assert.ok(at > html.indexOf('class="repos"'), 'below the repo bars');
  assert.ok(at < html.indexOf('Needs attention') && at < html.indexOf('In flight'));
  assert.match(html, /<h2>Burn-up <small>/);
});

test('renderBoard without the run\'s startedAt, or with one that is not a date, draws no burn-up', () => {
  for (const startedAt of [undefined, 'not a date']) {
    const html = renderBoard(view({ startedAt }));
    assert.ok(!html.includes('class="burn"'), String(startedAt));
    assert.match(html, /<footer>/, 'the rest of the page still renders');
  }
});

test('the burn-up\'s legend and end labels give the current counts; a ticket dropped before the run is not in scope', () => {
  const c = chart(renderBoard(view({ startedAt: STARTED })));
  assert.match(c, /<span class="end s"[^>]*>Scope this run 6<\/span>/);
  assert.match(c, /<span class="end d"[^>]*>Shipped this run 1<\/span>/);
  assert.match(c, /Scope<\/span>/);
  assert.match(c, /Shipped<\/span>/);
  assert.match(c, /aria-label="Burn-up: 1 of 6 shipped this run as of Oct 8, 1:30 PM PDT; 6 in scope when the run started, Oct 8, 5:00 AM PDT\."/);
});

test('with predecessor epics, the headline counts them and the burn-up labels its smaller totals as this run\'s', () => {
  const html = renderBoard(view({ startedAt: STARTED, before: [before(R(50), [60, 61, 62])] }));
  assert.match(html, /<b>4\/9<\/b><span>shipped \(3 before this run\)<\/span>/);
  const c = chart(html);
  assert.match(c, /<span class="end d"[^>]*>Shipped this run 1<\/span>/);
  assert.match(c, /<span class="end s"[^>]*>Scope this run 6<\/span>/);
  assert.match(c, /aria-label="Burn-up: 1 of 6 shipped this run as of /);
  assert.match(c, /<th>Shipped this run<\/th>/);
});

test('the burn-up\'s axis and tooltips are Pacific with their zone, never UTC', () => {
  const c = chart(renderBoard(view({ startedAt: STARTED })));
  for (const tick of ['6 AM PDT', '8 AM PDT', '10 AM PDT', '12 PM PDT']) { assert.ok(c.includes(`>${tick}</span>`), tick); }
  assert.match(c, /<b>Oct 8, 1:02 PM PDT<\/b>1 of 6 shipped this run, 5 to go<ul><li>Shipped <span class="r">r#1<\/span> <em>Ticket 1<\/em><\/li><\/ul>/);
  assert.doesNotMatch(c, /UTC|GMT|\dZ/);
});

test('the burn-up\'s steps are keyboard-reachable: one in the tab order, each with a tooltip it describes', () => {
  const c = chart(renderBoard(view({ startedAt: STARTED })));
  const pts = [...c.matchAll(/<div class="pt"[^>]*tabindex="(-?\d)"[^>]*aria-describedby="(burn-tip-\d+)"/g)];
  assert.equal(pts.length, 3, 'start, the shipped ticket, now');
  assert.deepEqual(pts.map((m) => m[1]), ['-1', '-1', '0'], 'the latest step takes the tab stop');
  for (const [, , id] of pts) { assert.ok(c.includes(`id="${id}"`), id); }
});

test('the burn-up table lists every point, newest first', () => {
  const c = chart(renderBoard(view({ startedAt: STARTED })));
  const table = c.slice(c.indexOf('<details>'));
  const rows = [...table.matchAll(/<tr><td class="n">([^<]+)<\/td><td class="n">(\d+)<\/td><td class="n">(\d+)<\/td><td class="n">(\d+)<\/td>/g)].map((m) => m.slice(1));
  assert.deepEqual(rows, [
    ['Oct 8, 1:30 PM PDT', '6', '1', '5'],
    ['Oct 8, 1:02 PM PDT', '6', '1', '5'],
    ['Oct 8, 5:00 AM PDT', '6', '0', '6'],
  ]);
});

test('the burn-up escapes a ticket title in its tooltip and its table', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const v = view({ startedAt: STARTED });
  v.tickets[3] = { ...v.tickets[3], title: evil, createdAt: '2026-10-08T15:00:00Z' };
  const c = chart(renderBoard(v));
  assert.ok(!c.includes(evil));
  assert.equal(c.split('&lt;img src=x onerror=alert(1)&gt;').length - 1, 2, 'once in the tooltip, once in the table');
});

// ---- milestones ----------------------------------------------------------

/** The example run with milestones: #1 reached, #3 next (behind #2, which is in flight), #7 can't be ordered; `notes` adds or renames. */
function msView({ labels = { 1: ['hitl-gate'], 3: ['hitl-gate'], 7: ['hitl-gate'] }, notes = {}, tickets = (t) => t } = {}) {
  const base = view();
  const ts = tickets(base.tickets.map((t) => ({ ...t, labels: labels[t.ref.split('#')[1]] ?? [] })));
  const v = { ...base, tickets: ts, notes: { ...base.notes, milestones: notes } };
  return { ...v, milestones: milestones(v) };
}
const section = (html) => html.slice(html.indexOf('<h2>Milestones'), html.indexOf('<h2>In flight'));

test('renderBoard draws a Milestones section before In flight, one row per milestone, with link, state and wave (issue #518)', () => {
  const html = renderBoard(msView());
  assert.ok(html.indexOf('<h2>Milestones') > 0 && html.indexOf('<h2>Milestones') < html.indexOf('<h2>In flight'), 'before In flight');
  const s = section(html);
  assert.equal((s.match(/<tr class="ms-row/g) || []).length, 3);
  assert.match(s, /Ticket 1[\s\S]*?href="https:\/\/github.com\/o\/r\/issues\/1"[\s\S]*?Reached Oct 8, 1:02 PM PDT[\s\S]*?shipped in wave 3/);
  assert.match(s, /Ticket 3<span class="chip ms-next">Next<\/span>[\s\S]*?Next up: 1 open ticket before it[\s\S]*?Wave 5</);
  assert.match(s, /Ticket 7[\s\S]*?Can't be ordered/);
  assert.equal((s.match(/ms-next/g) || []).length, 1, 'one Next chip');
});

test('renderBoard leaves the Milestones section out when there are none (issue #518)', () => {
  assert.ok(!renderBoard(view()).includes('<h2>Milestones'));
  assert.ok(!renderBoard(msView({ labels: {} })).includes('<h2>Milestones'));
});

test('renderBoard badges a milestone\'s road-ahead node and in-flight card (issue #518)', () => {
  const html = renderBoard(msView({ notes: { 'o/r#2': 'Wire it up' } }));
  assert.match(html, /<div class="card">(?:(?!<div class="card">)[\s\S])*?<div class="ms-badge">Milestone: Wire it up<\/div>/, 'in-flight card');
  assert.match(html, /data-ref="o\/r#3"(?:(?!data-ref)[\s\S])*?<div class="ms-badge">Milestone: Ticket 3<\/div>/, 'road-ahead node');
  assert.doesNotMatch(html, /data-ref="o\/r#4"(?:(?!data-ref)[\s\S])*?class="ms-badge"/, 'no badge on a ticket that is no milestone');
});

test('renderBoard highlights the road to the next milestone: its line, its nodes and its edges (issue #518)', () => {
  const html = renderBoard(msView());
  assert.match(html, /<div class="path ms-road"><span class="meta tight">Road to Ticket 3:<\/span>[\s\S]*?r#2[\s\S]*?r#3/);
  const road = [...html.matchAll(/<div class="node [^"]*\bmpath\b[^"]*"[^>]*data-ref="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(road, ['o/r#2', 'o/r#3']);
  const edges = JSON.parse(html.match(/data-edges="([^"]*)"/)[1].replaceAll('&quot;', '"'));
  assert.deepEqual(edges.filter((e) => e[3]).map((e) => `${e[0]}>${e[1]}`), ['o/r#2>o/r#3'], 'the fourth element marks road edges only');
});

test('renderBoard draws no road when no milestone is next (issue #518)', () => {
  const html = renderBoard(msView({ labels: { 1: ['hitl-gate'] } }));
  assert.doesNotMatch(html.slice(html.indexOf('</style>')), /ms-road|\bmpath\b/);
});

test('renderBoard names a milestone\'s outside blockers and escapes every milestone name (issue #518)', () => {
  const evil = '<script>alert(1)</script>';
  const base = view();
  const tickets = [...base.tickets.map((t) => ({ ...t, labels: [] })), ticket(8, 'blocked', { title: evil, labels: ['hitl-gate'] })];
  const graph = buildGraph([...base.graph.steps.flat(), 'o/r#6', 'o/r#7', 'o/r#8'], [
    { blockedBy: 'o/r#2', blocked: 'o/r#3' }, { blockedBy: 'o/r#6', blocked: 'o/r#7' }, { blockedBy: 'o/r#7', blocked: 'o/r#6' }, { blockedBy: 'o/r#9', blocked: 'o/r#8' },
  ], ['o/r#1', 'o/r#5'], { outside: ['o/r#9'] });
  const waves = projectWaves(graph, new Map(tickets.map((t) => [t.ref, t.status])), base.current);
  const v = { ...base, tickets, graph, waves, outsideTickets: [{ ref: 'o/r#9', title: 'Elsewhere', url: 'u9' }], notes: { milestones: { 'o/r#4': evil } } };
  const html = renderBoard({ ...v, milestones: milestones(v) });
  assert.ok(!html.includes(evil), 'no raw script from a title or a note');
  assert.match(section(html), /1 outside it \(<a href="u9">r#9<\/a>\)/);
});

test('renderBoard shows a dash for a milestone reached outside any wave (issue #518)', () => {
  const html = renderBoard(msView({ labels: { 1: ['hitl-gate'] }, tickets: (ts) => ts.map((t) => (t.ref === 'o/r#1' ? { ...t, shippedWave: undefined } : t)) }));
  assert.match(section(html), /Reached Oct 8, 1:02 PM PDT<\/td><td class="n">—<\/td>/);
});

test('renderBoard gives a data-edges triple no road flag when no milestone is next, and a fourth element when one is (issue #518)', () => {
  const edges = (html) => JSON.parse(html.match(/data-edges="([^"]*)"/)[1].replaceAll('&quot;', '"'));
  for (const html of [renderBoard(view()), renderBoard(msView({ labels: {} })), renderBoard(msView({ labels: { 1: ['hitl-gate'] } }))]) {
    assert.ok(edges(html).every((e) => e.length === 3), 'a run with no road renders its edges exactly as before');
  }
  assert.ok(edges(renderBoard(msView())).every((e) => e.length === 4), 'with a road, every triple carries the flag');
});

test('the milestone badge has its own class, apart from the road-edge class the script gives a path (issue #518)', () => {
  const html = renderBoard(msView());
  assert.match(html, /<div class="ms-badge">Milestone: Ticket 3<\/div>/);
  assert.doesNotMatch(html, /class="ms"/, 'no element is classed ms; that class belongs to path.ms in the road script');
  assert.match(PAGE_CSS, /\.ms-badge\{/);
  assert.doesNotMatch(PAGE_CSS, /(^|[\s,}])\.ms\s*\{/m, 'a bare .ms rule would also style the road\'s path.ms');
});

/** A run whose milestone, #4, waits on the open ticket #9 of another run, so its road runs #9 (step 1) → #4 (step 2). */
function blockedView(milestoneRows) {
  const base = view();
  const tickets = base.tickets.map((t) => ({ ...t, labels: [] }));
  const graph = buildGraph([...base.graph.steps.flat(), 'o/r#6', 'o/r#7'], [
    { blockedBy: 'o/r#2', blocked: 'o/r#3' }, { blockedBy: 'o/r#6', blocked: 'o/r#7' }, { blockedBy: 'o/r#7', blocked: 'o/r#6' }, { blockedBy: 'o/r#9', blocked: 'o/r#4' },
  ], ['o/r#1', 'o/r#5'], { outside: ['o/r#9'] });
  const waves = projectWaves(graph, new Map(tickets.map((t) => [t.ref, t.status])), base.current);
  const v = { ...base, tickets, graph, waves, outsideTickets: [{ ref: 'o/r#9', title: 'Elsewhere', url: 'u9' }], notes: { milestones: { 'o/r#4': 'Hear it' } } };
  return { ...v, milestones: milestoneRows ? milestoneRows(milestones(v)) : milestones(v) };
}

// The State and Wave cells of one milestone row, by what the row says (issue #518).
for (const [name, patch, state, wave] of [
  ['open tickets count the run\'s and the outside ones together, then split them (issue #522)', { next: true, before: 2, outside: ['o/r#9'] }, 'Next up: 3 open tickets before it: 2 in this run, 1 outside it (<a href="u9">r#9</a>)', 'Wave 5'],
  ['only outside tickets still count as open tickets before it, not as nothing (issue #522)', { next: true, before: 0, outside: ['o/r#9'] }, 'Next up: 1 open ticket before it: 0 in this run, 1 outside it (<a href="u9">r#9</a>)', 'Wave 5'],
  ['nothing open before it', { next: true, before: 0, outside: [] }, 'Next up: nothing open before it', 'Wave 5'],
  ['a row that is not next has no Next up prefix', { next: false, before: 1, outside: [] }, '1 open ticket before it', 'Wave 5'],
  ['a milestone of yours has no wave number', { wave: { label: null, now: false } }, '', 'Yours'],
  ['a milestone in the wave building now says so', { wave: { label: '4b', now: true } }, '', 'Wave 4b · building now'],
  ['an open milestone with no projected wave shows a dash', { wave: null }, '', '—'],
]) {
  test(`renderBoard Milestones row: ${name} (issue #518)`, () => {
    const html = renderBoard(blockedView((rows) => rows.map((m) => ({ ...m, ...patch }))));
    const cells = section(html).match(/<tr class="ms-row[^>]*>(?:<td[^>]*>.*?<\/td>){2}<td>(.*?)<\/td><td class="n">(.*?)<\/td><\/tr>/s);
    assert.ok(cells, 'one row');
    if (state) assert.equal(cells[1], state);
    assert.equal(cells[2], wave);
  });
}

test('renderBoard marks a building-now milestone and no other (issue #518)', () => {
  const html = renderBoard(blockedView((rows) => rows.map((m) => ({ ...m, wave: { label: '4b', now: true } }))));
  assert.match(section(html), /<td class="n">Wave 4b · building now<\/td>/);
  assert.doesNotMatch(section(renderBoard(blockedView())), /building now/);
});

test('the Road to line lists the road in step order, not ref order, and counts outside nodes apart (issue #518)', () => {
  const html = renderBoard(blockedView());
  const line = html.match(/<div class="path ms-road">.*?<\/div>/s)[0];
  assert.match(line, /Road to Hear it:/);
  // #4 sorts before #9 by ref, but #9 (outside) is the earlier step.
  assert.ok(line.indexOf('r#9') > 0 && line.indexOf('r#9') < line.indexOf('r#4'), line);
  assert.match(line, /\(1 ticket, 1 outside; outlined below\)/);
  const noOutside = renderBoard(msView()).match(/<div class="path ms-road">.*?<\/div>/s)[0];
  assert.match(noOutside, /\(2 tickets; outlined below\)/, 'no ", N outside" when none is');
});
