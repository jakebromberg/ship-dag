// model.mjs — the ETA of a ship-dag run, as pure functions over epoch milliseconds.
//
// Three limits converge, and the ETA is the latest of them:
//   1. each repo's merge queue (merges are serial per repo: remaining × the typical gap between its merges),
//   2. run-wide throughput (remaining × the typical gap between any two of the run's merges),
//   3. DAG depth (waves with an open ticket × the typical latency of one ticket, from its latest engine start to the
//      review pass of its PR, over the most recent review passes; the merge-queue wait is left out, since limit 1
//      already counts it).
// Every limit is a range: the 25th, 50th and 75th percentile of its samples give the optimistic, likely and
// pessimistic finish. No I/O here; state.mjs gathers the inputs.

export const DEFAULTS = Object.freeze({
  window: 6, // trailing merges per repo that set its service time
  runWindow: 12, // trailing run-wide merges that set throughput
  serviceFallbackMs: 15 * 60_000, // a repo's service time before it has two merges (its CI duration)
  waveLatencyMs: 2 * 3_600_000, // one wave's latency while fewer than minLatencySamples tickets have passed review
  minLatencySamples: 3, // review-passed tickets needed before depth trusts its own measurement
  latencyWindow: 8, // most recent review passes that set depth's latency (older ones, overnight waits among them, drop out)
});

/** The `q` quantile of `xs` by linear interpolation, or null when `xs` is empty. */
export function quantile(xs, q) {
  if (xs.length === 0) {
    return null;
  }
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const i = Math.floor(pos);
  return i + 1 < s.length ? s[i] + (s[i + 1] - s[i]) * (pos - i) : s[i];
}

/** The differences between consecutive times, after sorting them. */
export function gaps(times) {
  const s = [...times].sort((a, b) => a - b);
  return s.slice(1).map((t, i) => t - s[i]);
}

/** `{lo, mid, hi}`: the 25th, 50th and 75th percentiles of `samples`, or null with none. */
export function spread(samples) {
  if (samples.length === 0) {
    return null;
  }
  return { lo: quantile(samples, 0.25), mid: quantile(samples, 0.5), hi: quantile(samples, 0.75) };
}

const finishAfter = (now, count, per) => ({ lo: now + count * per.lo, mid: now + count * per.mid, hi: now + count * per.hi });
const flat = (ms) => ({ lo: ms, mid: ms, hi: ms });

/**
 * One repo's merge queue: its service time from the gaps between its last `window` + 1 merges, else `fallbackMs`.
 * @param {{merges: number[], remaining: number, now: number, window: number, fallbackMs: number}} input
 */
export function queueFinish({ merges, remaining, now, window, fallbackMs }) {
  const recent = [...merges].sort((a, b) => a - b).slice(-(window + 1));
  const measured = spread(gaps(recent));
  const service = measured ?? flat(fallbackMs);
  return { merged: merges.length, remaining, service, source: measured ? 'merges' : 'fallback', finish: finishAfter(now, remaining, service) };
}

/**
 * Run-wide throughput: the gaps between the run's last `window` + 1 merges, as a rate and a finish. With fewer than
 * two merges there is no rate, and `finish` is null.
 * @param {{merges: number[], remaining: number, now: number, window: number}} input
 */
export function throughputFinish({ merges, remaining, now, window }) {
  const per = spread(gaps([...merges].sort((a, b) => a - b).slice(-(window + 1))));
  if (!per) {
    return { perHour: null, remaining, merges: merges.length, finish: null };
  }
  return { perHour: 3_600_000 / per.mid, remaining, merges: merges.length, finish: finishAfter(now, remaining, per) };
}

/**
 * DAG depth: the planned waves that still hold an open ticket, times one ticket's latency (latest engine start to
 * review pass), measured over the last `window` of `latencies`, which run oldest review pass first. With fewer than
 * `minSamples` of them it uses `defaultMs`; `samples` says how many there were in all and `used` how many it took.
 * @param {{waves: string[][], open: Set<string>, latencies: number[], now: number, window: number, defaultMs: number, minSamples: number}} input
 */
export function depthFinish({ waves, open, latencies, now, window, defaultMs, minSamples }) {
  const left = waves.filter((w) => w.some((ref) => open.has(ref))).length;
  const recent = latencies.slice(-window);
  const measured = recent.length >= minSamples ? spread(recent) : null;
  const latency = measured ?? flat(defaultMs);
  return {
    waves: left, latency, samples: latencies.length, used: recent.length, minSamples,
    source: measured ? 'measured' : 'default', finish: finishAfter(now, left, latency),
  };
}

/**
 * The run's ETA.
 * @param {object} input
 * @param {number} input.now
 * @param {number} input.runStart  merges before it are not the run's
 * @param {Array<{ref: string, repo: string, open: boolean, mergedAt: number|null, startedAt: number|null, reviewedAt: number|null}>} input.nodes
 *   every ticket in scope; `startedAt` is its latest engine start, `reviewedAt` when its PR last passed review
 * @param {string[]} input.blocked  refs waiting on a human or an external blocker: listed, never counted
 * @param {string[][]} input.waves  the plan's waves
 * @param {Partial<typeof DEFAULTS> & {serviceFallbackMs?: number|Record<string, number>}} [input.opts]
 */
export function estimate({ now, runStart, nodes, blocked, waves, opts = {} }) {
  const o = { ...DEFAULTS, ...opts };
  const parked = new Set(blocked);
  const open = new Set(nodes.filter((n) => n.open && !parked.has(n.ref)).map((n) => n.ref));
  const merged = nodes.filter((n) => !n.open && n.mergedAt != null && n.mergedAt >= runStart);
  const fallbackFor = (repo) => (typeof o.serviceFallbackMs === 'number' ? o.serviceFallbackMs : o.serviceFallbackMs[repo] ?? DEFAULTS.serviceFallbackMs);

  const repos = [...new Set(nodes.map((n) => n.repo))];
  const queues = repos.map((repo) => ({
    repo,
    ...queueFinish({
      merges: merged.filter((n) => n.repo === repo).map((n) => n.mergedAt),
      remaining: nodes.filter((n) => n.repo === repo && open.has(n.ref)).length,
      now, window: o.window, fallbackMs: fallbackFor(repo),
    }),
  }));
  const throughput = throughputFinish({ merges: merged.map((n) => n.mergedAt), remaining: open.size, now, window: o.runWindow });
  const latencies = nodes.filter((n) => n.startedAt != null && n.reviewedAt != null && n.reviewedAt > n.startedAt)
    .sort((a, b) => a.reviewedAt - b.reviewedAt).map((n) => n.reviewedAt - n.startedAt);
  const depth = depthFinish({ waves, open, latencies, now, window: o.latencyWindow, defaultMs: o.waveLatencyMs, minSamples: o.minLatencySamples });

  const limits = [
    ...queues.filter((q) => q.remaining > 0).map((q) => ({ name: `queue ${q.repo}`, finish: q.finish })),
    ...(throughput.finish && open.size > 0 ? [{ name: 'throughput', finish: throughput.finish }] : []),
    ...(depth.waves > 0 ? [{ name: 'depth', finish: depth.finish }] : []),
  ];
  if (limits.length === 0) {
    return { now, eta: flat(now), binding: 'done', queues, throughput, depth, blocked: [...parked] };
  }
  const latest = (k) => Math.max(...limits.map((l) => l.finish[k]));
  const binding = limits.reduce((a, b) => (b.finish.mid > a.finish.mid ? b : a)).name;
  return { now, eta: { lo: latest('lo'), mid: latest('mid'), hi: latest('hi') }, binding, queues, throughput, depth, blocked: [...parked] };
}

const PACIFIC = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

/**
 * An instant in Pacific time with its zone label, e.g. `Sat, Oct 17, 10:52 AM PDT`. Built from the formatter's parts,
 * so the result is the same under every ICU version (they disagree on the separators between them).
 */
export function formatPacific(ms) {
  const p = Object.fromEntries(PACIFIC.formatToParts(new Date(ms)).map(({ type, value }) => [type, value]));
  return `${p.weekday}, ${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`;
}

/** A duration as `12m` or `1h 05m`. */
export function formatDuration(ms) {
  const total = Math.round(ms / 60_000);
  const h = Math.floor(total / 60);
  return h > 0 ? `${h}h ${String(total % 60).padStart(2, '0')}m` : `${total}m`;
}

const span = (r) => `${formatDuration(r.lo)} / ${formatDuration(r.mid)} / ${formatDuration(r.hi)}`;

/** What depth's latency rests on: `median of 5 tickets`, `median of the latest 8 of 27 tickets`, or the default. */
const depthBasis = (d) => {
  if (d.source !== 'measured') {
    return `default: ${d.samples} of ${d.minSamples} samples`;
  }
  return d.used < d.samples ? `median of the latest ${d.used} of ${d.samples} tickets` : `median of ${d.samples} tickets`;
};

/** The human-readable block: ETA range, binding constraint, per-repo table, throughput, depth, blocked, notes. */
export function renderText({ runId, now, eta, binding, queues, throughput, depth, blocked, notes = [] }) {
  const pad = (s, n) => String(s).padEnd(n);
  const width = Math.max(4, ...queues.map((q) => q.repo.length)) + 2;
  const lines = [
    `ship-dag ETA for ${runId} (as of ${formatPacific(now)})`,
    `ETA: ${formatPacific(eta.lo)} to ${formatPacific(eta.hi)}, likely ${formatPacific(eta.mid)}`,
    `Binding: ${binding}`,
    '',
    `${pad('repo', width)}${pad('merged', 8)}${pad('left', 6)}${pad('service p25/p50/p75', 26)}finish (likely)`,
    ...queues.map((q) => `${pad(q.repo, width)}${pad(q.merged, 8)}${pad(q.remaining, 6)}`
      + `${pad(span(q.service) + (q.source === 'fallback' ? '*' : ''), 26)}${q.remaining ? formatPacific(q.finish.mid) : 'drained'}`),
    '',
    throughput.finish
      ? `Throughput: ${throughput.perHour.toFixed(1)} merges/h over the last merges; ${throughput.remaining} left, likely done ${formatPacific(throughput.finish.mid)}`
      : `Throughput: not measured (${throughput.merges} merge(s) so far); ${throughput.remaining} left`,
    `Depth: ${depth.waves} wave(s) left x ${span(depth.latency)} per wave (${depthBasis(depth)}, latest engine start to review pass), likely done ${formatPacific(depth.finish.mid)}`,
    `${blocked.length} blocked, not counted${blocked.length ? `: ${blocked.join(', ')}` : ''}`,
  ];
  if (queues.some((q) => q.source === 'fallback')) {
    lines.push('* fewer than two merges: CI-duration fallback');
  }
  return [...lines, ...notes.map((n) => `Note: ${n}`)].join('\n');
}
