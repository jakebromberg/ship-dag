// Tests for the ETA model. Run: node --test scripts/eta/
//
// Every function is pure: times are plain epoch milliseconds counted from an
// arbitrary origin, so each case reads as minutes after the start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quantile, gaps, spread, queueFinish, throughputFinish, depthFinish, estimate, formatPacific, formatDuration, renderText,
} from './model.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const m = (n) => n * MIN;

// ---- quantile / gaps / spread ---------------------------------------------

for (const [xs, q, want] of [
  [[], 0.5, null],
  [[7], 0.25, 7],
  [[1, 2, 3, 4, 5], 0.5, 3],
  [[5, 1, 3], 0.5, 3],
  [[1, 2, 3, 4, 5], 0.25, 2],
  [[10, 20], 0.75, 17.5],
]) {
  test(`quantile(${JSON.stringify(xs)}, ${q}) is ${want}`, () => {
    assert.equal(quantile(xs, q), want);
  });
}

test('gaps sorts its times and returns the consecutive differences', () => {
  assert.deepEqual(gaps([30, 10, 15]), [5, 15]);
  assert.deepEqual(gaps([4]), []);
});

test('spread is the 25th, 50th and 75th percentiles, or null with no samples', () => {
  assert.deepEqual(spread([1, 2, 3, 4, 5]), { lo: 2, mid: 3, hi: 4 });
  assert.equal(spread([]), null);
});

// ---- queueFinish ----------------------------------------------------------

for (const [name, input, want] of [
  ['a queue with merges uses the gaps between them',
    { merges: [m(0), m(10), m(20), m(30)], remaining: 3, now: m(30), window: 6, fallbackMs: m(99) },
    { source: 'merges', service: { lo: m(10), mid: m(10), hi: m(10) }, finish: { lo: m(60), mid: m(60), hi: m(60) } }],
  ['only the trailing window of merges counts',
    { merges: [m(0), m(100), m(110), m(120)], remaining: 1, now: m(120), window: 2, fallbackMs: m(99) },
    { source: 'merges', service: { lo: m(10), mid: m(10), hi: m(10) }, finish: { lo: m(130), mid: m(130), hi: m(130) } }],
  ['fewer than two merges fall back to the CI duration',
    { merges: [m(5)], remaining: 2, now: m(10), window: 6, fallbackMs: m(12) },
    { source: 'fallback', service: { lo: m(12), mid: m(12), hi: m(12) }, finish: { lo: m(34), mid: m(34), hi: m(34) } }],
  ['merges that landed together (one PR closing several tickets) add no zero-length gap',
    { merges: [m(0), m(10), m(10), m(20)], remaining: 1, now: m(20), window: 6, fallbackMs: m(99) },
    { source: 'merges', service: { lo: m(10), mid: m(10), hi: m(10) }, finish: { lo: m(30), mid: m(30), hi: m(30) } }],
  ['merges that all landed together fall back to the CI duration',
    { merges: [m(5), m(5)], remaining: 1, now: m(10), window: 6, fallbackMs: m(12) },
    { source: 'fallback', service: { lo: m(12), mid: m(12), hi: m(12) }, finish: { lo: m(22), mid: m(22), hi: m(22) } }],
  ['a drained queue finishes now',
    { merges: [m(0), m(10)], remaining: 0, now: m(50), window: 6, fallbackMs: m(12) },
    { source: 'merges', service: { lo: m(10), mid: m(10), hi: m(10) }, finish: { lo: m(50), mid: m(50), hi: m(50) } }],
]) {
  test(`queueFinish: ${name}`, () => {
    const got = queueFinish(input);
    assert.equal(got.source, want.source);
    assert.deepEqual(got.service, want.service);
    assert.deepEqual(got.finish, want.finish);
    assert.equal(got.remaining, input.remaining);
  });
}

test('queueFinish spreads an uneven queue into an optimistic and a pessimistic finish', () => {
  const got = queueFinish({ merges: [m(0), m(10), m(30), m(60), m(100)], remaining: 2, now: m(100), window: 6, fallbackMs: m(1) });
  assert.deepEqual(got.service, { lo: m(17.5), mid: m(25), hi: m(32.5) });
  assert.deepEqual(got.finish, { lo: m(135), mid: m(150), hi: m(165) });
});

// ---- throughputFinish -----------------------------------------------------

test('throughputFinish turns the run-wide merge gaps into a rate and a finish', () => {
  const got = throughputFinish({ merges: [m(0), m(30), m(15), m(45)], remaining: 4, now: m(45), window: 12 });
  assert.equal(got.perHour, 4);
  assert.deepEqual(got.finish, { lo: m(105), mid: m(105), hi: m(105) });
});

test('throughputFinish has no rate and no finish with fewer than two merges', () => {
  assert.deepEqual(throughputFinish({ merges: [m(1)], remaining: 4, now: m(9), window: 12 }), { perHour: null, remaining: 4, merges: 1, finish: null });
});

test('throughputFinish has no rate when every merge landed at the same instant', () => {
  assert.deepEqual(throughputFinish({ merges: [m(3), m(3)], remaining: 2, now: m(9), window: 12 }), { perHour: null, remaining: 2, merges: 2, finish: null });
});

// ---- depthFinish ----------------------------------------------------------

for (const [name, input, want] of [
  ['counts only waves with an open node and uses the measured latency',
    { waves: [['a', 'b'], ['c'], ['d']], open: new Set(['b', 'd']), latencies: [HOUR, 2 * HOUR, 3 * HOUR], now: 0, defaultMs: 9 * HOUR, minSamples: 3 },
    { waves: 2, source: 'measured', samples: 3, finish: { lo: 3 * HOUR, mid: 4 * HOUR, hi: 5 * HOUR } }],
  ['falls back to the default latency with nothing measured',
    { waves: [['a']], open: new Set(['a']), latencies: [], now: HOUR, defaultMs: 2 * HOUR, minSamples: 3 },
    { waves: 1, source: 'default', samples: 0, finish: { lo: 3 * HOUR, mid: 3 * HOUR, hi: 3 * HOUR } }],
  ['falls back to the default latency with fewer samples than the minimum, and still counts them',
    { waves: [['a']], open: new Set(['a']), latencies: [HOUR, 5 * HOUR], now: 0, defaultMs: 2 * HOUR, minSamples: 3 },
    { waves: 1, source: 'default', samples: 2, finish: { lo: 2 * HOUR, mid: 2 * HOUR, hi: 2 * HOUR } }],
  ['no open wave finishes now',
    { waves: [['a']], open: new Set(), latencies: [HOUR, HOUR, HOUR], now: HOUR, defaultMs: 2 * HOUR, minSamples: 3 },
    { waves: 0, source: 'measured', samples: 3, finish: { lo: HOUR, mid: HOUR, hi: HOUR } }],
]) {
  test(`depthFinish ${name}`, () => {
    const got = depthFinish(input);
    assert.equal(got.waves, want.waves);
    assert.equal(got.source, want.source);
    assert.equal(got.samples, want.samples);
    assert.deepEqual(got.finish, want.finish);
  });
}

// ---- estimate -------------------------------------------------------------

// `startedAt` is the ticket's latest engine start and `reviewedAt` when its PR last passed review.
const node = (ref, { open = true, mergedAt = null, startedAt = null, reviewedAt = null } = {}) => ({ ref, repo: ref.split('#')[0], open, mergedAt, startedAt, reviewedAt });

test('estimate takes the latest of the three limits and names the binding one', () => {
  const nodes = [
    // o/slow: two merges 30 min apart, three left: finishes at +90 min.
    node('o/slow#1', { open: false, mergedAt: m(0), startedAt: m(-20), reviewedAt: m(0) }),
    node('o/slow#2', { open: false, mergedAt: m(30), startedAt: m(10), reviewedAt: m(30) }),
    node('o/slow#3'), node('o/slow#4'), node('o/slow#5'),
    // o/fast: two merges 5 min apart, one left.
    node('o/fast#1', { open: false, mergedAt: m(20), startedAt: m(0), reviewedAt: m(20) }),
    node('o/fast#2', { open: false, mergedAt: m(25), startedAt: m(5), reviewedAt: m(25) }),
    node('o/fast#3'),
    // Blocked: never counted.
    node('o/slow#9'),
  ];
  const got = estimate({
    now: m(30), runStart: m(-30), nodes, blocked: ['o/slow#9'], waves: [['o/slow#3', 'o/fast#3'], ['o/slow#4'], ['o/slow#5', 'o/slow#9']],
  });
  assert.equal(got.binding, 'queue o/slow');
  assert.deepEqual(got.eta, { lo: m(120), mid: m(120), hi: m(120) });
  assert.deepEqual(got.queues.map((q) => [q.repo, q.merged, q.remaining]), [['o/slow', 2, 3], ['o/fast', 2, 1]]);
  assert.deepEqual(got.blocked, ['o/slow#9']);
  assert.equal(got.depth.waves, 3);
  assert.equal(got.throughput.remaining, 4);
});

test('estimate ignores merges from before the run started', () => {
  const nodes = [
    node('o/r#1', { open: false, mergedAt: m(-100) }),
    node('o/r#2', { open: false, mergedAt: m(10) }),
    node('o/r#3', { open: false, mergedAt: m(20) }),
    node('o/r#4'),
  ];
  const got = estimate({ now: m(20), runStart: m(0), nodes, blocked: [], waves: [['o/r#4']] });
  assert.equal(got.queues[0].merged, 2);
  assert.deepEqual(got.queues[0].service, { lo: m(10), mid: m(10), hi: m(10) });
});

test('estimate binds on depth when one ticket sits behind a long chain', () => {
  const nodes = [
    node('o/r#1', { open: false, mergedAt: m(10), startedAt: m(-50), reviewedAt: m(10) }),
    node('o/r#2', { open: false, mergedAt: m(20), startedAt: m(-40), reviewedAt: m(20) }),
    node('o/r#5', { startedAt: m(-60), reviewedAt: m(0) }), // passed review, waiting in the queue
    node('o/r#3'), node('o/r#4'),
  ];
  const got = estimate({ now: m(20), runStart: m(-60), nodes, blocked: [], waves: [['o/r#3', 'o/r#5'], ['o/r#4']] });
  assert.equal(got.binding, 'depth');
  assert.equal(got.depth.samples, 3);
  assert.deepEqual(got.eta, { lo: m(140), mid: m(140), hi: m(140) });
});

for (const [name, nodes, want] of [
  ['runs from the latest engine start to the review pass, leaving out the merge wait',
    [0, 1, 2].map((i) => node(`o/r#${i}`, { open: false, mergedAt: m(500 + i), startedAt: m(10 * i), reviewedAt: m(10 * i + 30) })),
    { samples: 3, source: 'measured', mid: m(30) }],
  ['skips a ticket with no review pass yet, or one restarted after its pass',
    [node('o/r#1', { startedAt: m(0) }), node('o/r#2', { startedAt: m(50), reviewedAt: m(40) }), node('o/r#3', { startedAt: m(0), reviewedAt: m(30) })],
    { samples: 1, source: 'default', mid: 2 * HOUR }],
]) {
  test(`estimate's depth latency ${name}`, () => {
    const got = estimate({ now: m(600), runStart: 0, nodes: [...nodes, node('o/r#9')], blocked: [], waves: [['o/r#9']] });
    assert.equal(got.depth.samples, want.samples);
    assert.equal(got.depth.source, want.source);
    assert.equal(got.depth.latency.mid, want.mid);
  });
}

test('estimate with nothing left is done now', () => {
  const got = estimate({ now: m(5), runStart: 0, nodes: [node('o/r#1', { open: false, mergedAt: m(1) })], blocked: [], waves: [] });
  assert.equal(got.binding, 'done');
  assert.deepEqual(got.eta, { lo: m(5), mid: m(5), hi: m(5) });
});

// ---- formatting -----------------------------------------------------------

for (const [iso, want] of [
  ['2026-10-17T17:52:00Z', 'Sat, Oct 17, 10:52 AM PDT'],
  ['2026-12-01T08:05:00Z', 'Tue, Dec 1, 12:05 AM PST'],
]) {
  test(`formatPacific(${iso}) is ${want}`, () => {
    assert.equal(formatPacific(Date.parse(iso)), want);
  });
}

test('formatPacific is empty for an invalid instant rather than throwing', () => {
  assert.equal(formatPacific(NaN), '');
  assert.equal(formatPacific(Infinity), '');
});

for (const [ms, want] of [[m(12), '12m'], [m(65), '1h 05m'], [m(0.4), '0m'], [26 * HOUR, '26h 00m']]) {
  test(`formatDuration(${ms}) is ${want}`, () => {
    assert.equal(formatDuration(ms), want);
  });
}

test('renderText shows the range in Pacific, the binding constraint, the per-repo table and the blocked count', () => {
  const nodes = [
    node('o/r#1', { open: false, mergedAt: Date.parse('2026-10-17T17:00:00Z') }),
    node('o/r#2', { open: false, mergedAt: Date.parse('2026-10-17T17:10:00Z') }),
    node('o/r#3'), node('o/r#4'),
  ];
  const now = Date.parse('2026-10-17T17:10:00Z');
  const got = estimate({ now, runStart: 0, nodes, blocked: ['o/r#4'], waves: [['o/r#3', 'o/r#4']] });
  const text = renderText({ ...got, runId: 'sd-1', notes: ['gh unavailable'] });
  assert.match(text, /sd-1/);
  assert.match(text, /as of Sat, Oct 17, 10:10 AM PDT/);
  assert.match(text, /Binding: depth/);
  assert.match(text, /Depth: 1 wave\(s\) left x 2h 00m .*\(default: 0 of 3 samples, latest engine start to review pass\)/);
  assert.match(text, /o\/r +2 +1 +10m/);
  assert.match(text, /1 blocked, not counted: o\/r#4/);
  assert.match(text, /Note: gh unavailable/);
  assert.doesNotMatch(text, /UTC|Z\b/);
});

test('renderText keeps a gap between a wide service range and the finish column', () => {
  const nodes = [
    node('o/r#1', { open: false, mergedAt: Date.parse('2026-10-17T00:00:00Z') }),
    node('o/r#2', { open: false, mergedAt: Date.parse('2026-10-17T11:00:00Z') }),
    node('o/r#3'),
  ];
  const got = estimate({ now: Date.parse('2026-10-17T11:00:00Z'), runStart: 0, nodes, blocked: [], waves: [['o/r#3']] });
  assert.match(renderText({ ...got, runId: 'sd-1' }), /11h 00m \/ 11h 00m \/ 11h 00m +Sat, Oct 17/);
});
