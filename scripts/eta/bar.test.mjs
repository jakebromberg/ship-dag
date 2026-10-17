// Tests for the ETA progress bar's pure layout. Run: node --test scripts/eta/
//
// The axis runs from the run's start to the pessimistic ETA. Times are minutes from an arbitrary origin, so a marker
// at minute t on a 0..100 axis of 11 cells lands in cell round(t / 10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GLYPHS, shortRepo, barModel, cellOf, layoutBar, compactBar, renderBar } from './bar.mjs';
import { estimate } from './model.mjs';

const MIN = 60_000;
const m = (n) => n * MIN;

// ---- shortRepo -------------------------------------------------------------

for (const [repo, want] of [
  ['o/Backend-Service', 'BS'],
  ['o/dj-site', 'DJ site'],
  ['o/o-shared', 'shared'],
  ['acme/acme-web-app', 'web app'],
  ['acme/Widgets', 'Widgets'],
]) {
  test(`shortRepo(${repo}) is ${want}`, () => {
    assert.equal(shortRepo(repo), want);
  });
}

// ---- cellOf ----------------------------------------------------------------

for (const [at, want] of [
  [m(0), { cell: 0, past: false }],
  [m(44), { cell: 4, past: false }],
  [m(100), { cell: 10, past: false }],
  [m(250), { cell: 10, past: true }],
  [m(-30), { cell: 0, past: false }],
]) {
  test(`cellOf(${at / MIN} min) on a 0..100 min axis of 11 cells is ${JSON.stringify(want)}`, () => {
    assert.deepEqual(cellOf(at, 0, m(100), 11), want);
  });
}

test('cellOf puts everything in the first cell of an empty axis', () => {
  assert.deepEqual(cellOf(m(5), m(5), m(5), 11), { cell: 0, past: false });
});

// ---- barModel --------------------------------------------------------------

// A real 2026 instant as the origin: ICU names no zone abbreviation for some dates before 1970.
const T0 = Date.parse('2026-10-17T17:00:00Z');
const t = (n) => T0 + m(n);
const node = (ref, { open = true, mergedAt = null, startedAt = null, reviewedAt = null } = {}) => ({ ref, repo: ref.split('#')[0], open, mergedAt, startedAt, reviewedAt });

function liveResult() {
  const nodes = [
    node('o/dj-site#1', { open: false, mergedAt: t(0), startedAt: t(-20), reviewedAt: t(0) }),
    node('o/dj-site#2', { open: false, mergedAt: t(30), startedAt: t(10), reviewedAt: t(30) }),
    node('o/dj-site#3'), node('o/dj-site#4'), node('o/dj-site#5'),
    node('o/o-shared#1', { open: false, mergedAt: t(20), startedAt: t(0), reviewedAt: t(20) }),
    node('o/o-shared#2', { open: false, mergedAt: t(25), startedAt: t(5), reviewedAt: t(25) }),
    node('o/o-shared#3'),
    node('o/dj-site#9'),
  ];
  const r = estimate({ now: t(30), runStart: t(-30), nodes, blocked: ['o/dj-site#9'], waves: [['o/dj-site#3', 'o/o-shared#3'], ['o/dj-site#4'], ['o/dj-site#5']] });
  return { ...r, runId: 'sd-1', runStart: t(-30) };
}

test('barModel lays the axis from the run start to the late ETA and names every point of interest', () => {
  const b = barModel(liveResult());
  assert.equal(b.start, t(-30));
  assert.equal(b.end, t(120));
  assert.deepEqual([b.merged, b.total], [4, 8]);
  assert.equal(b.binding, 'queue:o/dj-site');
  assert.deepEqual(b.markers.map((k) => [k.id, k.glyph, k.label]), [
    ['now', GLYPHS.now, 'now'],
    ['early', GLYPHS.early, 'early ETA'],
    ['likely', GLYPHS.likely, 'likely ETA'],
    ['late', GLYPHS.late, 'late ETA'],
    ['queue:o/dj-site', 'D', 'DJ site queue'],
    ['queue:o/o-shared', 'S', 'shared queue'],
    ['pace', GLYPHS.pace, 'overall pace'],
    ['waves', GLYPHS.waves, 'waves left'],
  ]);
});

test('barModel numbers the queue glyphs when two repos share a first letter', () => {
  const r = liveResult();
  const b = barModel({ ...r, queues: [...r.queues, { ...r.queues[0], repo: 'o/docs' }] });
  assert.deepEqual(b.markers.filter((k) => k.id.startsWith('queue:')).map((k) => k.glyph), ['1', 'S', '2']);
});

for (const [binding, want] of [['throughput', 'pace'], ['depth', 'waves'], ['done', null], ['queue o/r', 'queue:o/r']]) {
  test(`barModel maps the binding constraint ${binding} to the marker ${want}`, () => {
    assert.equal(barModel({ ...liveResult(), binding }).binding, want);
  });
}

// ---- layoutBar -------------------------------------------------------------

const model = (markers, binding = null, extra = {}) => ({
  runId: 'sd-1', now: m(40), start: 0, end: m(100), merged: 3, total: 9, binding,
  markers: [{ id: 'now', glyph: '▲', label: 'now', at: m(40) }, ...markers], ...extra,
});

test('layoutBar fills up to now, shades early to late, and puts each glyph in its cell', () => {
  const got = layoutBar(model([
    { id: 'early', glyph: '‹', label: 'early ETA', at: m(70) },
    { id: 'late', glyph: '›', label: 'late ETA', at: m(100) },
  ]), 11);
  assert.equal(got.bar, '█████··░░░░');
  assert.equal(got.marks, '    ▲  ‹  ›');
});

for (const [name, markers, binding, wantMarks, wantHidden] of [
  ['the binding marker wins a shared cell', [{ id: 'a', glyph: 'A', label: 'a', at: m(70) }, { id: 'b', glyph: 'B', label: 'b', at: m(71) }], 'b', '    ▲  B   ', ['a']],
  ['without a binding marker the first listed wins', [{ id: 'a', glyph: 'A', label: 'a', at: m(70) }, { id: 'b', glyph: 'B', label: 'b', at: m(71) }], null, '    ▲  A   ', ['b']],
  ['a marker past the end clamps to the last cell with an arrow after it', [{ id: 'a', glyph: 'A', label: 'a', at: m(300) }], null, '    ▲     A→', []],
]) {
  test(`layoutBar: ${name}`, () => {
    const got = layoutBar(model(markers, binding), 11);
    assert.equal(got.marks, wantMarks);
    assert.deepEqual(got.legend.filter((l) => l.hiddenBy).map((l) => l.id), wantHidden);
  });
}

test('layoutBar keeps every marker in the legend, naming the one that took its cell', () => {
  const got = layoutBar(model([{ id: 'a', glyph: 'A', label: 'a', at: m(70) }, { id: 'b', glyph: 'B', label: 'b', at: m(70) }], 'b'), 11);
  assert.deepEqual(got.legend.map((l) => [l.id, l.hiddenBy ?? null, l.binding]), [['now', null, false], ['a', 'b', false], ['b', null, true]]);
});

// ---- compactBar / renderBar ------------------------------------------------

test('compactBar is a fixed-width bar with the binding glyph in its cell', () => {
  const got = compactBar(model([{ id: 'late', glyph: '›', label: 'late ETA', at: m(100) }, { id: 'w', glyph: '≡', label: 'waves left', at: m(95) }], 'w'), 20);
  assert.equal(got, '[█████████·········≡·]');
  assert.equal(got.length, 22);
});

for (const [columns, wantLines, wantFull] of [[40, 3, false], [59, 3, false], [60, 4, true], [100, 4, true]]) {
  test(`renderBar at ${columns} columns is ${wantFull ? 'the full bar with a legend' : 'the compact bar'}`, () => {
    const b = barModel(liveResult());
    const lines = renderBar(b, columns);
    assert.ok(lines.every((l) => [...l].length <= columns), lines.join('\n'));
    assert.match(lines[0], /4\/8 merged/);
    if (wantFull) {
      assert.ok(lines.length >= wantLines + b.markers.length - 1);
      assert.match(lines.join('\n'), /DJ site queue .* P[DS]T \(binding\)/);
      assert.match(lines.join('\n'), /start +\S.* P[DS]T/);
    } else {
      assert.equal(lines.length, wantLines);
      assert.match(lines[1], /^likely \w{3} \d+:\d\d [AP]M P[DS]T$/);
      assert.equal(lines[2], 'bound by DJ site queue');
    }
  });
}
