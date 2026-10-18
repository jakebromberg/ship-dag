// Tests for the burn-up model: the step series of scope and shipped over a run, the Pacific time ticks under it,
// and the hover buckets that fold steps too close together to point at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { burnupSeries, bucketPoints, pacificTicks, yScale } from './burnup.mjs';

const R = (n) => `o/r#${n}`;
const START = '2026-10-17T15:00:00.000Z';
const NOW = '2026-10-17T21:00:00.000Z';
const at = (iso) => Date.parse(iso);
const ticket = (n, status, extra = {}) => ({ ref: R(n), title: `Ticket ${n}`, status, createdAt: '2026-10-01T00:00:00Z', closedAt: null, ...extra });
const counts = (points) => points.map((p) => [new Date(p.t).toISOString(), p.scope, p.done]);

test('tickets that existed at the start all enter at the start; a later one enters when it was filed', () => {
  const points = burnupSeries({ tickets: [ticket(1, 'ready'), ticket(2, 'blocked'), ticket(3, 'ready', { createdAt: '2026-10-17T17:30:00Z' })], startedAt: START, now: NOW });
  assert.deepEqual(counts(points), [
    [START, 2, 0],
    ['2026-10-17T17:30:00.000Z', 3, 0],
    [NOW, 3, 0],
  ]);
  assert.deepEqual(points[0].items.map((i) => [i.kind, i.ref]), [['filed', R(1)], ['filed', R(2)]]);
  assert.deepEqual(points[1].items, [{ kind: 'filed', ref: R(3), title: 'Ticket 3' }]);
  assert.deepEqual(points[2].items, [], 'the point at now changes nothing');
});

test('a ticket closed as completed counts as shipped when it closed; one closed as not planned leaves scope then and never counts as shipped', () => {
  const points = burnupSeries({ tickets: [
    ticket(1, 'shipped', { closedAt: '2026-10-17T16:00:00Z' }),
    ticket(2, 'dropped', { closedAt: '2026-10-17T18:00:00Z' }),
    ticket(3, 'flight'),
  ], startedAt: START, now: NOW });
  assert.deepEqual(counts(points), [
    [START, 3, 0],
    ['2026-10-17T16:00:00.000Z', 3, 1],
    ['2026-10-17T18:00:00.000Z', 2, 1],
    [NOW, 2, 1],
  ]);
  assert.deepEqual(points[1].items, [{ kind: 'done', ref: R(1), title: 'Ticket 1' }]);
  assert.deepEqual(points[2].items, [{ kind: 'dropped', ref: R(2), title: 'Ticket 2' }]);
});

test('a ticket shipped before the run started counts as shipped at the start; one dropped before it is never in scope', () => {
  const points = burnupSeries({ tickets: [
    ticket(1, 'shipped', { closedAt: '2026-10-10T00:00:00Z' }),
    ticket(2, 'dropped', { closedAt: '2026-10-10T00:00:00Z' }),
    ticket(3, 'ready'),
  ], startedAt: START, now: NOW });
  assert.deepEqual(counts(points), [[START, 2, 1], [NOW, 2, 1]]);
  assert.deepEqual(points[0].items.map((i) => [i.kind, i.ref]), [['filed', R(1)], ['filed', R(3)], ['done', R(1)]]);
});

test('changes at the same instant form one point, filed before shipped before dropped, refs in order within each', () => {
  const t = '2026-10-17T19:00:00Z';
  const points = burnupSeries({ tickets: [
    ticket(10, 'dropped', { closedAt: t }), ticket(9, 'shipped', { closedAt: t }), ticket(12, 'ready', { createdAt: t }), ticket(11, 'ready', { createdAt: t }),
  ], startedAt: START, now: NOW });
  assert.equal(points.length, 3);
  assert.deepEqual(points[1].items.map((i) => [i.kind, i.ref]), [['filed', R(11)], ['filed', R(12)], ['done', R(9)], ['dropped', R(10)]]);
  assert.deepEqual([points[1].scope, points[1].done], [3, 1]);
});

test('a ticket filed and shipped after the start enters and ships at its own times; no change lands after now', () => {
  const points = burnupSeries({ tickets: [
    ticket(1, 'shipped', { createdAt: '2026-10-17T16:00:00Z', closedAt: '2026-10-17T17:00:00Z' }),
    ticket(2, 'shipped', { createdAt: '2026-10-17T16:00:00Z', closedAt: '2026-10-17T23:00:00Z' }), // a clock ahead of ours
  ], startedAt: START, now: NOW });
  assert.deepEqual(counts(points), [
    [START, 0, 0],
    ['2026-10-17T16:00:00.000Z', 2, 0],
    ['2026-10-17T17:00:00.000Z', 2, 1],
    [NOW, 2, 2],
  ]);
  assert.deepEqual(points[3].items.map((i) => i.ref), [R(2)]);
});

test('a ticket with no createdAt enters at the start; a run that has not started yet ends where it begins', () => {
  assert.deepEqual(counts(burnupSeries({ tickets: [ticket(1, 'ready', { createdAt: undefined })], startedAt: START, now: NOW })), [[START, 1, 0], [NOW, 1, 0]]);
  assert.deepEqual(counts(burnupSeries({ tickets: [ticket(1, 'ready')], startedAt: START, now: START })), [[START, 1, 0]]);
});

test('bucketPoints folds steps closer than the gap into one hover target, ending at the last of them', () => {
  const t0 = at(START);
  const span = 1000 * 60 * 100; // 100 minutes, so 1 minute = 1%
  const p = (min, scope) => ({ t: t0 + min * 60000, scope, done: 0, items: [{ kind: 'filed', ref: R(min), title: '' }] });
  const buckets = bucketPoints([p(0, 1), p(10, 2), p(10.3, 3), p(10.6, 4), p(50, 5), p(100, 5)], t0, t0 + span, 0.005);
  assert.deepEqual(buckets.map((b) => [b.from, b.to.scope, b.items.length]), [
    [t0, 1, 1], [t0 + 10 * 60000, 4, 3], [t0 + 50 * 60000, 5, 1], [t0 + 100 * 60000, 5, 1],
  ]);
});

for (const [name, from, to, want] of [
  ['an afternoon in whole hours', '2026-10-17T15:27:10Z', '2026-10-17T21:10:00Z', ['9 AM PDT', '10 AM PDT', '11 AM PDT', '12 PM PDT', '1 PM PDT', '2 PM PDT']],
  ['an hour in quarter hours', '2026-10-17T16:05:00Z', '2026-10-17T17:05:00Z', ['9:15 AM PDT', '9:30 AM PDT', '9:45 AM PDT', '10 AM PDT']],
  ['two days, naming the day each time it changes', '2026-10-16T15:00:00Z', '2026-10-18T03:00:00Z', ['Oct 16, 12 PM PDT', '6 PM PDT', 'Oct 17, 12 AM PDT', '6 AM PDT', '12 PM PDT', '6 PM PDT']],
  ['two weeks in days', '2026-10-01T15:00:00Z', '2026-10-14T15:00:00Z', ['Oct 2', 'Oct 4', 'Oct 6', 'Oct 8', 'Oct 10', 'Oct 12', 'Oct 14']],
  ['across the fall-back change, in PST after it', '2026-11-01T06:00:00Z', '2026-11-01T14:00:00Z', ['Nov 1, 12 AM PDT', '2 AM PST', '4 AM PST', '6 AM PST']],
]) {
  test(`pacificTicks: ${name}`, () => {
    const ticks = pacificTicks(at(from), at(to), 7);
    assert.deepEqual(ticks.map((k) => k.label), want);
    for (const k of ticks) { assert.ok(k.t >= at(from) && k.t <= at(to), `${k.label} inside the range`); }
  });
}

test('pacificTicks puts each tick on its Pacific wall-clock boundary, never a UTC one', () => {
  const [first] = pacificTicks(at('2026-10-16T15:00:00Z'), at('2026-10-18T03:00:00Z'), 7);
  assert.equal(new Date(first.t).toISOString(), '2026-10-16T19:00:00.000Z', 'noon PDT');
  assert.deepEqual(pacificTicks(at(START), at(START), 7), [], 'no span, no ticks');
});

for (const [max, want] of [[0, { step: 1, top: 1 }], [3, { step: 1, top: 3 }], [7, { step: 2, top: 8 }], [42, { step: 10, top: 50 }], [96, { step: 20, top: 100 }], [480, { step: 100, top: 500 }]]) {
  test(`yScale(${max}) steps by ${want.step} to ${want.top}`, () => assert.deepEqual(yScale(max), want));
}
