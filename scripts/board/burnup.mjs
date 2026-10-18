// burnup.mjs — the status board's burn-up model: how many tickets were in scope and how many had shipped at every
// moment of the run, the Pacific time ticks under the chart, and the y scale beside it.
//
// Pure, like model.mjs: the CLI hands in the tickets (with GitHub's createdAt and closedAt) and the run's startedAt,
// and render.mjs draws what comes back. Times are epoch milliseconds here; the renderer formats them in Pacific.

import { compareRefs } from './model.mjs';

const KIND_ORDER = { filed: 0, done: 1, dropped: 2 };

/**
 * The run's burn-up as a step series. A ticket enters scope when it was filed, but never before the run started:
 * every ticket that existed at `startedAt` enters there. A ticket the board calls `shipped` counts as done when it
 * closed; one it calls `dropped` (closed as not planned) leaves scope when it closed and never counts as done, and one
 * dropped before the run started is never in scope at all. A change GitHub dates after `now` is drawn at `now`.
 *
 * There is a point at the start, one at each later instant something changed (its `items`, filed before done before
 * dropped, by ref within each), and one at `now` when nothing changed then.
 *
 * @param {object} a
 * @param {Array<{ref:string,title:string,status:string,createdAt?:string|null,closedAt?:string|null}>} a.tickets
 * @param {string} a.startedAt  ISO instant the run started (board.json)
 * @param {string} a.now  ISO instant the page is built
 * @returns {Array<{t:number,scope:number,done:number,items:Array<{kind:'filed'|'done'|'dropped',ref:string,title:string}>}>}
 */
export function burnupSeries({ tickets, startedAt, now }) {
  const t0 = Date.parse(startedAt);
  const end = Math.max(t0, Date.parse(now));
  const clamp = (iso, floor) => Math.min(end, Math.max(floor, Date.parse(iso ?? '') || floor));
  const events = [];
  for (const { ref, title, status, createdAt, closedAt } of tickets) {
    const closed = status === 'shipped' || status === 'dropped';
    const close = closed ? clamp(closedAt, t0) : null;
    if (status === 'dropped' && close <= t0) { continue; } // gone before the run began
    const enter = Math.min(clamp(createdAt, t0), close ?? end);
    events.push({ t: enter, kind: 'filed', ref, title });
    if (closed) { events.push({ t: close, kind: status === 'shipped' ? 'done' : 'dropped', ref, title }); }
  }
  events.sort((a, b) => a.t - b.t || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || compareRefs(a.ref, b.ref));

  const points = [{ t: t0, scope: 0, done: 0, items: [] }];
  for (const { t, kind, ref, title } of events) {
    let p = points[points.length - 1];
    if (p.t !== t) { p = { ...p, t, items: [] }; points.push(p); }
    if (kind === 'filed') { p.scope += 1; } else if (kind === 'done') { p.done += 1; } else { p.scope -= 1; }
    p.items.push({ kind, ref, title });
  }
  if (points[points.length - 1].t < end) { points.push({ ...points[points.length - 1], t: end, items: [] }); }
  return points;
}

/**
 * Fold points closer together than `gap` (a fraction of the span `t0`..`t1`) into one hover target, chaining: each
 * point joins the bucket of the point before it when that one is near enough. A bucket starts at its first point's
 * time (`from`), shows its last point's counts (`to`), and lists every item in it.
 *
 * @param {ReturnType<typeof burnupSeries>} points
 * @returns {Array<{from:number, to:ReturnType<typeof burnupSeries>[number], items:Array<object>}>}
 */
export function bucketPoints(points, t0, t1, gap) {
  const span = Math.max(1, t1 - t0);
  const buckets = [];
  points.forEach((p, i) => {
    const last = buckets[buckets.length - 1];
    if (last && (p.t - points[i - 1].t) / span < gap) {
      last.to = p;
      last.items.push(...p.items);
    } else {
      buckets.push({ from: p.t, to: p, items: [...p.items] });
    }
  });
  return buckets;
}

/** The y axis: the smallest step from a 1–2–5 ladder that covers `max` in five steps or fewer, and the top it reaches. */
export function yScale(max) {
  const ladder = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  const step = ladder.find((s) => Math.ceil(max / s) <= 5) ?? 10000;
  return { step, top: Math.max(1, Math.ceil(max / step)) * step };
}

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
});
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An instant's Pacific wall clock, as parts and as the epoch ms that wall clock would be in UTC. */
function wall(ms) {
  const p = Object.fromEntries(PARTS.formatToParts(new Date(ms)).map(({ type, value }) => [type, value]));
  const month = MONTHS.indexOf(p.month);
  const hour = Number(p.hour) % 24;
  return { ...p, hour, minute: Number(p.minute), date: `${p.month} ${p.day}`, ms: Date.UTC(Number(p.year), month, Number(p.day), hour, Number(p.minute)) };
}

/** The instant a Pacific wall-clock time (as UTC epoch ms) names: its offset read at a first guess, then rechecked. */
function instantOf(wallMs) {
  const guess = wallMs - (wall(wallMs).ms - wallMs);
  return wallMs - (wall(guess).ms - guess);
}

const MINUTE = 60000;
const DAY = 1440;
const INTERVALS = [15, 30, 60, 120, 180, 360, 720, DAY, 2 * DAY, 7 * DAY]; // minutes

/**
 * Time ticks for the x axis between `t0` and `t1`, at most `max` of them, on Pacific wall-clock boundaries: quarter
 * hours up to days. A sub-day tick reads `9 AM PDT` or `9:30 AM PDT` (PST once the clocks change), and names its date
 * (`Oct 17, 12 AM PDT`) when the date differs from the tick before it, the first tick too when the range spans dates.
 * A day tick is the Pacific midnight it falls on, labelled by date alone (`Oct 17`).
 *
 * @returns {Array<{t:number,label:string}>}
 */
export function pacificTicks(t0, t1, max) {
  if (!(t1 > t0)) { return []; }
  const minutes = (t1 - t0) / MINUTE;
  const every = INTERVALS.find((m) => minutes / m <= max) ?? Math.ceil(minutes / max / DAY) * DAY;
  const start = wall(t0);
  const midnight = Date.UTC(1970, 0, 1) + Math.floor(start.ms / (DAY * MINUTE)) * DAY * MINUTE;
  // Sub-day ticks fall on multiples of the interval since midnight; day ticks start at the first midnight in range.
  let w = every < DAY ? midnight + Math.ceil((start.ms - midnight) / (every * MINUTE)) * every * MINUTE
    : midnight + (start.ms > midnight ? DAY * MINUTE : 0);
  const spansDates = start.date !== wall(t1).date;
  const ticks = [];
  let prevDate = spansDates ? null : start.date;
  for (; ticks.length <= max + 1; w += every * MINUTE) {
    const t = instantOf(w);
    if (t > t1) { break; }
    if (t < t0) { continue; }
    const p = wall(t);
    let label;
    if (every >= DAY) {
      label = p.date;
    } else {
      const h12 = p.hour % 12 || 12;
      const clock = `${h12}${p.minute ? `:${String(p.minute).padStart(2, '0')}` : ''} ${p.hour < 12 ? 'AM' : 'PM'} ${p.timeZoneName}`;
      label = p.date === prevDate ? clock : `${p.date}, ${clock}`;
    }
    prevDate = p.date;
    ticks.push({ t, label });
  }
  return ticks;
}
