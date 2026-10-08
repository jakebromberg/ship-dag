// Tests for the status board renderer. The page is checked structurally — the
// sections a reader relies on are present, every string is escaped, and every
// time is Pacific with its zone — not byte-for-byte, so styling can move freely.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, projectWaves, makeShortRef } from './model.mjs';
import { renderBoard } from './render.mjs';

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
  const graph = buildGraph(open, [
    { blockedBy: R(2), blocked: R(3) }, { blockedBy: R(6), blocked: R(7) }, { blockedBy: R(7), blocked: R(6) },
  ]);
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
  assert.match(html, /Wave 5/, 'the ticket waiting on wave 4b projects to wave 5');
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
  v.notes = { callouts: [{ title: evil, html: evil }], wave: evil };
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
  const graph = buildGraph([], []);
  const html = renderBoard({ ...v, tickets, graph, waves: new Map(), current: null });
  assert.match(html, /Nothing left open\./);
  assert.match(html, /No PR open right now\./);
});
