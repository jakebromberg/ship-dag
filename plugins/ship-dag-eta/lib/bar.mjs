// bar.mjs — the ETA as a progress bar over time, as pure layout: from the run's start to the late (pessimistic) ETA,
// filled up to now, shaded from the early to the late ETA, with a glyph for each point of interest on a row beneath
// and a legend that names every one, its Pacific time and which is binding. Plain strings, so the mod's pane, its
// status line and the CLI draw the same thing.

import { formatPacific, formatPacificShort, waitingOn } from './model.mjs';

export const GLYPHS = Object.freeze({ now: '▲', early: '‹', likely: '◆', late: '›', pace: '~', waves: '≡' });
const FILLED = '█';
const SHADED = '░';
const BOTH = '▓';
const EMPTY = '·';
const PAST = '→';
const COMPACT_BELOW = 60; // columns: narrower than this draws the compact bar

/**
 * A short display name for `owner/repo`: the owner's prefix dropped, capitalized words to initials, short words
 * upper-cased. Never empty: a name that shortens to nothing is given back whole.
 */
export function shortRepo(repo) {
  const [owner, name = owner] = repo.split('/');
  const prefix = `${owner}-`.toLowerCase();
  const words = (name.toLowerCase().startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name).split('-');
  const short = words.length > 1 && words.every((w) => /^[A-Z]/.test(w))
    ? words.map((w) => w[0]).join('')
    : words.map((w) => (w.length <= 2 ? w.toUpperCase() : w)).join(' ');
  return short.trim() || repo;
}

/**
 * The bar's model from `estimate`'s result (with `runId` and `runStart`): axis, counts, binding marker and markers.
 * A finished (`done`) or blocked run has no ETA markers; a blocked one carries `waiting`, the message that says so.
 */
export function barModel(r) {
  const queues = r.queues.filter((q) => q.remaining > 0);
  const names = queues.map((q) => shortRepo(q.repo));
  const firsts = names.map((s) => s[0].toUpperCase());
  let n = 0;
  const glyphs = firsts.map((g) => (firsts.filter((o) => o === g).length > 1 ? String(++n) : g));
  const eta = r.binding === 'done' || r.binding === 'blocked' ? [] : [
    { id: 'early', glyph: GLYPHS.early, label: 'early ETA', at: r.eta.lo },
    { id: 'likely', glyph: GLYPHS.likely, label: 'likely ETA', at: r.eta.mid },
    { id: 'late', glyph: GLYPHS.late, label: 'late ETA', at: r.eta.hi },
  ];
  const markers = [
    { id: 'now', glyph: GLYPHS.now, label: 'now', at: r.now },
    ...eta,
    ...queues.map((q, i) => ({ id: `queue:${q.repo}`, glyph: glyphs[i], label: `${names[i]} queue`, at: q.finish.mid })),
    ...(r.throughput.finish && r.throughput.remaining > 0 ? [{ id: 'pace', glyph: GLYPHS.pace, label: 'overall pace', at: r.throughput.finish.mid }] : []),
    ...(r.depth.waves > 0 ? [{ id: 'waves', glyph: GLYPHS.waves, label: 'waves left', at: r.depth.finish.mid }] : []),
  ];
  const merged = r.throughput.merges;
  return { runId: r.runId, now: r.now, start: r.runStart, end: r.eta.hi, merged, total: merged + r.throughput.remaining, binding: r.binding, waiting: r.binding === 'blocked' ? waitingOn(r.blocked.length) : null, markers };
}

/** The cell `at` falls in on a `width`-cell axis from `start` to `end`, clamped to the axis; `past` when beyond its end. */
export function cellOf(at, start, end, width) {
  if (end <= start) {
    return { cell: 0, past: false };
  }
  const cell = Math.round(((at - start) / (end - start)) * (width - 1));
  return { cell: Math.min(width - 1, Math.max(0, cell)), past: cell > width - 1 };
}

/**
 * The bar row, the marker row and the legend at `width` cells. A cell two markers share shows the binding one, else
 * the one listed first; the legend keeps both and names the one on top (`hiddenBy`). A marker past the end clamps to
 * the last cell, with an arrow after the bar.
 */
export function layoutBar(b, width) {
  const at = (id) => b.markers.find((k) => k.id === id);
  const cell = (t) => cellOf(t, b.start, b.end, width).cell;
  const nowCell = cell(b.now);
  const [lo, hi] = at('early') && at('late') ? [cell(at('early').at), cell(at('late').at)] : [width, -1];
  const bar = Array.from({ length: width }, (_, i) => {
    const shaded = i >= lo && i <= hi;
    return i <= nowCell ? (shaded ? BOTH : FILLED) : shaded ? SHADED : EMPTY;
  }).join('');
  const placed = b.markers.map((k) => ({ ...k, ...cellOf(k.at, b.start, b.end, width), binding: k.id === b.binding }));
  const owner = new Map();
  for (const k of placed.toSorted((a, z) => z.binding - a.binding)) {
    if (!owner.has(k.cell)) {
      owner.set(k.cell, k);
    }
  }
  const marks = Array.from({ length: width }, (_, i) => owner.get(i)?.glyph ?? ' ').join('') + (placed.some((p) => p.past) ? PAST : '');
  const legend = placed.map((k) => ({ ...k, hiddenBy: owner.get(k.cell).id === k.id ? undefined : owner.get(k.cell).id }));
  return { bar, marks, legend };
}

/** The compact bar for the status line: `[` + `width` cells + `]`, the binding marker's glyph in its cell. */
export function compactBar(b, width = 20) {
  const { bar, legend } = layoutBar(b, width);
  const binding = legend.find((k) => k.binding);
  return `[${[...bar].map((c, i) => (i === binding?.cell ? binding.glyph : c)).join('')}]`;
}

const fit = (line, columns) => [...line].slice(0, columns).join('');

/**
 * The bar as lines no wider than `columns`: below 60 columns the compact bar, the likely ETA (or that nothing is
 * left) and the binding constraint; from 60 the full bar, its marker row and a legend with the run's start and every
 * marker's Pacific time, shortened to weekday and time when the full date would cut a line's notes off.
 */
export function renderBar(b, columns) {
  const count = ` ${b.merged}/${b.total} merged`;
  const binding = b.markers.find((k) => k.id === b.binding);
  if (columns < COMPACT_BELOW) {
    const likely = b.markers.find((k) => k.id === 'likely');
    return [
      `${compactBar(b)}${count}`,
      likely ? `likely ${formatPacificShort(likely.at)}` : b.waiting ?? 'nothing left to merge',
      ...(binding ? [`bound by ${binding.label}`] : []),
    ].map((l) => fit(l, columns));
  }
  const width = Math.min(100, columns - count.length - 2);
  const { bar, marks, legend } = layoutBar(b, width);
  const entries = [{ glyph: '├', label: 'start', at: b.start }, ...legend];
  const notes = (k) => `${k.binding ? ' (binding)' : ''}${k.past ? ` ${PAST} past the end` : ''}`
    + `${k.hiddenBy ? ` (under ${legend.find((o) => o.id === k.hiddenBy).glyph})` : ''}`;
  const widest = Math.max(...entries.map((k) => k.label.length));
  // The time and its notes (binding, under) always fit; the label column gives way, after the date does.
  const rows = (format) => {
    const tails = entries.map((k) => `${format(k.at)}${notes(k)}`);
    const pad = Math.max(0, Math.min(widest, columns - 3 - Math.max(...tails.map((x) => [...x].length))));
    return { cut: pad < widest, lines: entries.map((k, i) => `${k.glyph} ${fit(k.label, pad).padEnd(pad)} ${tails[i]}`) };
  };
  const full = rows(formatPacific);
  const legendRows = full.cut ? rows(formatPacificShort).lines : full.lines;
  return [`${bar}${count}`, marks, ...legendRows, ...(b.waiting ? [b.waiting] : [])].map((l) => fit(l, columns));
}
