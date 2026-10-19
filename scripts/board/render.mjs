// render.mjs — the status board page, as one self-contained HTML string.
//
// Pure: the caller hands in every fact (tickets, the graph from model.mjs, the
// projected waves, the notes) and the current time, and gets a page back. Every
// interpolated string is escaped by the `html` template, notes included; every time is Pacific
// with its zone label. The stylesheet and road-ahead script are inlined from
// assets.mjs so the page needs nothing beside it.

import { orderSteps, formatPacific, compareRefs, leadingWaveNumber } from './model.mjs';
import { parseRef } from '../lib/ref.mjs';
import { PAGE_CSS, ROAD_JS, BURN_JS } from './assets.mjs';
import { html, raw, list } from './html.mjs';
import { burnupSeries, bucketPoints, pacificTicks, yScale } from './burnup.mjs';

/**
 * Every status `classify` returns, in legend order: the CSS token its bar
 * segment, swatch and chip (`.c-<status>`) use, its tile and legend labels, and
 * its chip label. A dropped ticket has no tile, bar segment or legend entry.
 */
export const STATUSES = [
  { status: 'shipped', token: 'ship', tile: 'shipped', legend: 'Shipped', chip: 'Shipped' },
  { status: 'flight', token: 'flight', tile: 'PR open', legend: 'PR open', chip: 'PR open' },
  { status: 'ready', token: 'ready', tile: 'ready to start', legend: 'Ready to start', chip: 'Ready' },
  { status: 'you', token: 'block', tile: 'waiting on you', legend: 'Waiting on you', chip: 'Yours' },
  { status: 'blocked', token: 'queued', tile: 'waiting on other tickets', legend: 'Waiting on other tickets', chip: 'Waiting' },
  { status: 'dropped', token: 'queued', tile: null, legend: null, chip: 'Dropped' },
];
const SHOWN = STATUSES.filter((s) => s.legend);
const CHIP = Object.fromEntries(STATUSES.map((s) => [s.status, s.chip]));

/**
 * The STATUSES entry whose chip colour each engine stage label (`deriveStage`, stage.mjs) wears. A chip's colour
 * follows its word: Stalled is red in the in-flight cards and the road ahead alike, never the yellow of a Ready
 * ticket that happens to be listed beside it. Building, In review, Reviewed and Fixing are work in progress, so
 * blue; Stalled and Review unreadable need a person, so red, like Yours. A label not listed here (a hand-written
 * stage from the board notes) keeps the ticket's status colour. Tiles, legend, bar and node borders count by
 * status and do not read this table.
 */
const STAGE_STATUS = new Map([
  ['Building', 'flight'],
  ['In review', 'flight'],
  ['Reviewed', 'flight'],
  ['Fixing', 'flight'],
  ['Stalled', 'you'],
  ['Review unreadable', 'you'],
]);

/** A status chip: its label is the ticket's stage if it has one, else the status's own; its class follows the label, or the status when the stage is not in STAGE_STATUS. */
const chip = (status, stage) => {
  const wears = STAGE_STATUS.get(stage) ?? status;
  return html`<span class="chip c-${wears}">${stage || CHIP[status] || status}</span>`;
};

/** `1 ticket`, `2 tickets`. */
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A step's wave labels as one span, ordered by wave number, then id: `wave 4b`, `waves 9–31b`. */
export function waveSpan(labels) {
  const sorted = [...labels].sort((a, b) => leadingWaveNumber(a) - leadingWaveNumber(b) || (a < b ? -1 : a > b ? 1 : 0));
  return sorted.length === 1 ? `wave ${sorted[0]}` : `waves ${sorted[0]}–${sorted[sorted.length - 1]}`;
}

/**
 * @param {object} v
 * @param {string} v.title  page title
 * @param {string} v.runId
 * @param {{url:string,label:string,title:string}|null} v.scope  link to the epic / label / set the run ships
 * @param {string} v.now  ISO instant the page was built
 * @param {Array<{ref:string,title:string,url:string,status:string,stage?:string,note?:string,
 *   prs:Array<{number:number,url:string,state:'open'|'merged'|'closed'}>,closedAt?:string,shippedWave?:string}>} v.tickets
 * @param {ReturnType<import('./model.mjs').buildGraph>} v.graph  over the open tickets
 * @param {{id:string, refs:Set<string>}|null} v.current  the wave building now
 * @param {Map<string,{label:string|null,now:boolean}>} v.waves  projectWaves() result
 * @param {(ref:string) => string} v.shortRef
 * @param {(repo:string) => string} v.repoLabel  `makeRepoLabel`'s labeller, over the same repos as `shortRef`
 * @param {{callouts?:Array<{owner?:string,title:string,text?:string}>, wave?:string, gates?:Record<string,string>}} v.notes
 *   a callout's `text` is plain text, escaped like everything else
 * @param {Array<{ref:string,url:string,title:string,dropped:number,shipped:Array<{ref:string,title:string,url:string,closedAt?:string}>}>} [v.before]
 *   `shippedBefore`'s result: what the predecessor epics shipped before this run. Counted in the headline, listed in a collapsed section.
 * @param {string} v.rebuild  the command that rebuilds this page
 * @param {string} [v.startedAt]  ISO instant the run started (board.json); with a parseable one, the page draws the burn-up, which
 *   reads each ticket's `createdAt` (absent: it was in scope from the start)
 * @returns {string}
 */
export function renderBoard(v) {
  const byRef = new Map(v.tickets.map((t) => [t.ref, t]));
  const link = (ref, label, url = byRef.get(ref)?.url) => html`<a href="${url || ''}">${label || v.shortRef(ref)}</a>`;
  const prLinks = (t, only) => t.prs.filter((p) => only.includes(p.state))
    .map((p) => html`<a class="pr pr-${p.state}" href="${p.url}" title="${p.state}">#${p.number}</a>`);
  const counts = {};
  for (const t of v.tickets) counts[t.status] = (counts[t.status] || 0) + 1;
  const earlier = (v.before || []).reduce((n, g) => n + g.shipped.length, 0);
  counts.shipped = (counts.shipped || 0) + earlier; // the headline and the bar count the whole project
  const total = v.tickets.length - (counts.dropped || 0) + earlier;
  const notes = v.notes || {};

  const h = [html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + html`<meta http-equiv="refresh" content="120"><title>${v.title}</title><style>${raw(PAGE_CSS)}</style></head><body><main>`];
  h.push(html`<h1>${v.title}</h1>${v.scope && html`<p class="sub"><a href="${v.scope.url}">${v.scope.label}</a> — ${v.scope.title}</p>`}`
    + html`<p class="meta">Updated ${formatPacific(v.now, 'long')} · run ${v.runId} · reloads every 2 minutes</p>`);
  h.push(html`<div class="tiles">${SHOWN.map(({ status, tile }) => {
    const n = status === 'shipped' ? `${counts.shipped || 0}/${total}` : counts[status] || 0;
    return html`<div class="tile"><b>${n}</b><span>${tile}${status === 'shipped' && earlier ? ` (${earlier} before this run)` : ''}</span></div>`;
  })}</div>`);
  h.push(bar(counts, total));
  h.push(html`<div class="legend">${SHOWN.map(({ token, legend }) => html`<span><i style="background:var(--${token})"></i>${legend}</span>`)}</div>`);
  h.push(repoBars(v.tickets, v.repoLabel));
  const burn = Number.isFinite(Date.parse(v.startedAt ?? '')); // a hand-edited startedAt that is not a date skips the chart
  if (burn) { h.push(burnup(v, link)); }

  if (notes.callouts?.length) {
    h.push(html`<h2>Needs attention</h2><div class="callouts">${notes.callouts.map((c) => html`<div class="callout${c.owner === 'you' ? ' you' : ''}"><b>${c.title}</b>${c.text}</div>`)}</div>`);
  }

  const flight = v.tickets.filter((t) => t.status === 'flight').sort((a, b) => compareRefs(a.ref, b.ref));
  const defaultSubtitle = v.current ? `wave ${v.current.id}` : '';
  h.push(html`<h2>In flight <small>${notes.wave || defaultSubtitle}</small></h2>`);
  h.push(flight.length
    ? html`<div class="cards">${flight.map((t) => html`<div class="card"><div class="top">${link(t.ref)}${chip('flight', t.stage)}</div><div class="t">${t.title}</div><div>${list(prLinks(t, ['open', 'merged']), ' ')}</div>${t.note && html`<div class="note">${t.note}</div>`}</div>`)}</div>`
    : html`<p class="sub">No PR open right now.</p>`);
  const just = v.current ? v.tickets.filter((t) => t.status === 'shipped' && v.current.refs.has(t.ref)) : [];
  if (just.length) {
    h.push(html`<p class="meta gap">Shipped this wave: ${list(just.map((t) => html`${link(t.ref)} ${list(prLinks(t, ['merged']), ' ')}`), ', ')}</p>`);
  }

  h.push(html`<h2>Road ahead <small>every open ticket, in dependency order</small></h2>`);
  h.push(roadAhead(v, byRef, link, notes.gates || {}));

  const shipped = v.tickets.filter((t) => t.status === 'shipped').sort((a, b) => (b.closedAt || '').localeCompare(a.closedAt || ''));
  h.push(html`<h2>Shipped <small>${plural(shipped.length, 'ticket')}, newest first</small></h2><details><summary>Show all ${shipped.length}</summary>`
    + html`<div class="tw"><table><thead><tr><th>Ticket</th><th>Title</th><th>PR</th><th>Wave</th><th>Closed</th></tr></thead><tbody>${shipped.map((t) => {
      const merged = prLinks(t, ['merged']);
      return html`<tr><td class="n">${link(t.ref)}</td><td>${t.title}</td><td class="n">${merged.length ? list(merged, ' ') : html`<span class="meta">—</span>`}</td><td class="n">${t.shippedWave || ''}</td><td class="n">${formatPacific(t.closedAt)}</td></tr>`;
    })}</tbody></table></div></details>`);
  for (const g of v.before || []) {
    h.push(html`<details><summary>Shipped before this run: ${link(g.ref, null, g.url)} — ${g.title} `
      + html`(${g.shipped.length}${g.dropped ? `, plus ${g.dropped} closed without shipping` : ''})</summary>`
      + html`<div class="tw"><table><thead><tr><th>Ticket</th><th>Title</th><th>Closed</th></tr></thead><tbody>${g.shipped.map((t) => html`<tr><td class="n">${link(t.ref, null, t.url)}</td><td>${t.title}</td><td class="n">${formatPacific(t.closedAt)}</td></tr>`)}</tbody></table></div></details>`);
  }
  const dropped = v.tickets.filter((t) => t.status === 'dropped');
  if (dropped.length) {
    h.push(html`<details><summary>Closed without shipping (${dropped.length})</summary><div class="items">${dropped.map((t) => html`<span class="item">${link(t.ref)} <span class="x">${t.title}</span></span>`)}</div></details>`);
  }
  h.push(html`<footer>Times are Pacific. Rebuild with <code>${v.rebuild}</code>. Built from GitHub, the run's engine state, its review files and telemetry, and its board notes. Local file, not committed.</footer></main>`
    + html`<script>${raw(ROAD_JS)}</script>${burn ? html`<script>${raw(BURN_JS)}</script>` : ''}</body></html>`);
  return h.join('\n');
}

function bar(counts, total) {
  const segs = SHOWN.filter(({ status }) => counts[status]).map(({ status, token }) => html`<i style="flex:${counts[status]};background:var(--${token})"></i>`);
  return html`<div class="bar" role="img" aria-label="${counts.shipped || 0} of ${total} shipped">${segs}</div>`;
}

function repoBars(tickets, repoLabel) {
  const repos = new Map();
  for (const t of tickets) {
    const repo = parseRef(t.ref)?.repo;
    if (t.status === 'dropped' || !repo) continue; // a bare ref names no repo to count it under
    const c = repos.get(repo) || {};
    c[t.status] = (c[t.status] || 0) + 1;
    repos.set(repo, c);
  }
  const size = (c) => Object.values(c).reduce((a, b) => a + b, 0);
  return html`<div class="repos">${[...repos].sort((a, b) => size(b[1]) - size(a[1])).map(([repo, c]) => html`<div class="repo"><b>${repoLabel(repo)}</b> · ${c.shipped || 0}/${size(c)} shipped${bar(c, size(c))}</div>`)}</div>`;
}

function roadAhead(v, byRef, link, gates) {
  const g = v.graph;
  const h = [];
  const sorted = (refs) => [...refs].sort(compareRefs);
  if (g.unorderable.size) {
    h.push(html`<div class="callouts"><div class="callout you"><b>Can't be ordered</b>These tickets are in a dependency cycle, or wait behind one or behind an open ticket outside this board, so no step can start them: ${list(sorted(g.unorderable).map((r) => link(r)), ', ')}.</div></div>`);
  }
  if (!g.steps.length) return [...h, html`<p class="sub">${g.unorderable.size ? 'Nothing can be ordered.' : 'Nothing left open.'}</p>`].join('\n');
  const rows = orderSteps(g);
  const chain = new Set(g.chain);
  const chainEdges = new Set(g.chain.slice(1).map((r, i) => `${g.chain[i]}>${r}`));
  const status = (r) => byRef.get(r)?.status;
  const wave = (r) => v.waves.get(r) || { label: null, now: false };
  const waveText = (r) => (wave(r).label === null ? 'Yours, not an engine wave' : `Wave ${wave(r).label}${wave(r).now ? ' · building now' : ''}`);
  const rowWaves = (row) => {
    const labels = [...new Set(row.map((r) => wave(r).label).filter((l) => l !== null))];
    const yours = row.some((r) => wave(r).label === null) ? ' + yours' : '';
    return labels.length ? waveSpan(labels) + yours : 'yours';
  };
  // Every open ticket, the unorderable ones too, so the count agrees with the callout above.
  const count = g.steps.flat().length;
  const left = g.unorderable.size
    ? html`${plural(count + g.unorderable.size, 'ticket')} left: ${count} in ${plural(rows.length, 'step')}, ${g.unorderable.size} can't be ordered.`
    : html`${plural(count, 'ticket')} left, in ${plural(rows.length, 'step')}.`;
  h.push(html`<p class="road-sum"><b>${left}</b> A step is the earliest a ticket can start: once every ticket it points up to has shipped. Tickets in the same step can be built at the same time.</p>`);
  h.push(html`<p class="howto"><b>Waves</b> continue the run's count.${v.current && html` Wave ${v.current.id} is building now;`} the later numbers are a projection that assumes each wave ships before the next starts. A ticket moves to a later wave if review sends it back, or if a wave launches without it. A ticket of yours, such as a release you cut, takes no wave: what waits on it goes in the next wave after you finish it.</p>`);
  h.push(html`<div class="path"><span class="meta tight">Longest chain:</span>${list(g.chain.map((r) => link(r)), '<span class="arr">→</span>')}<span class="meta tight">(${plural(g.chain.length, 'ticket')}, one after another)</span></div>`);
  h.push('<p class="howto">Lines show direct dependencies only; one implied by a longer chain is left out. The blue chain is the longest one: nothing finishes before it does. Hover or tab to a ticket to trace everything it waits on and everything waiting on it.</p>');
  const edges = rows.flat().flatMap((r) => sorted(g.direct.get(r)).map((p) => [p, r, chainEdges.has(`${p}>${r}`)]));
  h.push(html`<div class="dag" id="dag" data-edges="${JSON.stringify(edges)}"><svg aria-hidden="true"></svg>`);
  rows.forEach((row, i) => {
    h.push(html`<div class="row"><div class="lab"><b>Step ${i + 1}</b><span class="wv">${rowWaves(row)}</span>${plural(row.length, 'ticket')} · ${i === 0 ? 'can start now' : 'waits on earlier steps'}</div><div class="ns">`);
    for (const r of row) {
      const t = byRef.get(r) || { title: '' };
      const st = status(r);
      const after = [...g.direct.get(r)].sort((a, b) => g.stepOf.get(a) - g.stepOf.get(b) || compareRefs(a, b)).map((p) => v.shortRef(p)).join(', ');
      const desc = g.descendants.get(r);
      h.push(html`<div class="node s-${st}${chain.has(r) ? ' crit' : ''}" tabindex="0" data-ref="${r}"><div class="top">${link(r)}${chip(st, t.stage)}</div><div class="t" title="${t.title}">${t.title}</div><div class="wn${wave(r).now ? ' now' : ''}">${waveText(r)}</div>${gates[r] && html`<div class="gate">Needs: ${gates[r]}</div>`}<div class="dep">${after ? `after ${after}` : 'nothing open before it'}</div><div class="dep">${desc.size ? `unblocks ${desc.size}` : 'nothing waits on it'}</div></div>`);
    }
    h.push('</div></div>');
  });
  h.push('</div>');
  h.push('<details><summary>Order of work as a table</summary><div class="tw"><table><thead><tr><th>Step</th><th>Wave</th><th>Ticket</th><th>Title</th><th>Waits on</th><th>Unblocks</th></tr></thead><tbody>');
  rows.forEach((row, i) => {
    for (const r of row) {
      const waits = sorted(g.direct.get(r)).map((p) => link(p));
      h.push(html`<tr><td class="n">${i + 1}</td><td class="n">${wave(r).label ?? 'yours'}</td><td class="n">${link(r)}</td><td>${byRef.get(r)?.title}</td><td>${waits.length ? list(waits, ', ') : '—'}</td><td class="n">${g.descendants.get(r).size}</td></tr>`);
    }
  });
  h.push('</tbody></table></div></details>');
  return h.join('\n');
}

const VERB = { filed: 'Filed', done: 'Shipped', dropped: 'Closed without shipping' };
const TIP_ITEMS = 6; // a tooltip lists this many changes, then counts the rest
const BUCKET_GAP = 0.005; // steps closer than this share of the run's span are one hover target
const pct = (n) => `${Number(n.toFixed(2))}%`;

/**
 * The burn-up: scope and shipped over the run as an inline SVG step chart. The SVG holds only the lines (in a
 * 0–100 viewBox stretched to the plot, strokes kept at their pixel width); every label is HTML placed by percent, so
 * text stays readable at any width. Each hover target is a column from the midpoint before its step to the midpoint
 * after, so pointing anywhere snaps to the nearest step; its tooltip is the next sibling, shown by CSS on hover or
 * focus. One column is in the tab order and the arrow keys move between them (burn.js). A table repeats the data.
 */
function burnup(v, link) {
  const points = burnupSeries({ tickets: v.tickets, startedAt: v.startedAt, now: v.now });
  const first = points[0];
  const last = points[points.length - 1];
  const [t0, t1] = [first.t, last.t];
  const span = Math.max(1, t1 - t0);
  const { step, top } = yScale(Math.max(...points.map((p) => p.scope)));
  const X = (t) => ((t - t0) / span) * 100;
  const Y = (n) => 100 - (n / top) * 100;
  const when = (t) => formatPacific(new Date(t).toISOString());
  const path = (key) => `M${X(t0)},${Y(first[key])}${points.slice(1).map((p) => ` H${X(p.t)} V${Y(p[key])}`).join('')} H100`;
  const ys = [];
  for (let n = 0; n <= top; n += step) { ys.push(n); }
  const ticks = pacificTicks(t0, t1, 7);
  // The table links each ref; the tooltip can't be clicked (and its links would be stray tab stops), so it names them.
  const change = (it, ref = link(it.ref)) => html`${VERB[it.kind]} ${ref} <em>${it.title}</em>`;

  const grid = [...ys.map((n) => html`<line class="grid" x1="0" x2="100" y1="${Y(n)}" y2="${Y(n)}"/>`),
    ...ticks.map((k) => html`<line class="grid v" x1="${X(k.t)}" x2="${X(k.t)}" y1="0" y2="100"/>`)];
  const done = path('done');
  const svg = html`<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${grid}<path class="area" d="${done} V100 H0 Z"/><path class="scope" d="${path('scope')}"/><path class="done" d="${done}"/></svg>`;
  const labels = html`${ys.map((n) => html`<span class="yl" style="top:${pct(Y(n))}">${n}</span>`)}${ticks.map((k, i) => {
    const x = X(k.t);
    const edge = x < 6 ? ' first' : x > 94 ? ' last' : '';
    return html`<span class="xl${i % 2 ? ' odd' : ''}${edge}" style="left:${pct(x)}">${k.label}</span>`;
  })}`;
  // End labels sit beside the last step; when the two lines end close together, they part around the middle.
  let [sy, dy] = [Y(last.scope), Y(last.done)];
  if (dy - sy < 9) { const mid = (sy + dy) / 2; [sy, dy] = [mid - 4.5, mid + 4.5]; }
  const ends = html`<span class="end s" style="top:${pct(sy)}">Scope this run ${last.scope}</span><span class="end d" style="top:${pct(dy)}">Shipped this run ${last.done}</span>`;

  const buckets = bucketPoints(points, BUCKET_GAP);
  const xs = buckets.map((b) => X(b.to.t));
  const cols = buckets.map((b, i) => {
    const left = i ? (xs[i - 1] + xs[i]) / 2 : 0;
    const right = i < buckets.length - 1 ? (xs[i] + xs[i + 1]) / 2 : 100;
    const width = Math.max(right - left, 0.01);
    const at = `left:${pct(((xs[i] - left) / width) * 100)}`;
    const p = b.to;
    const from = when(b.from);
    const to = when(p.t);
    const head = b.from === p.t ? to : from.split(', ')[0] === to.split(', ')[0] ? `${from} to ${to.split(', ')[1]}` : `${from} to ${to}`;
    const status = `${p.done} of ${p.scope} shipped this run, ${p.scope - p.done} to go`;
    const shown = b.items.slice(0, TIP_ITEMS).map((it) => html`<li>${change(it, html`<span class="r">${v.shortRef(it.ref)}</span>`)}</li>`);
    if (b.items.length > TIP_ITEMS) { shown.push(html`<li>and ${b.items.length - TIP_ITEMS} more</li>`); }
    const place = xs[i] > 50 ? `right:calc(${pct(100 - xs[i])} + 10px)` : `left:calc(${pct(xs[i])} + 10px)`;
    const dots = html`<i class="rule" style="${at}"></i><i class="dot s" style="${at};top:${pct(Y(p.scope))}"></i><i class="dot d" style="${at};top:${pct(Y(p.done))}"></i>`;
    const tip = html`<div class="tip" id="burn-tip-${i}" style="${place}"><b>${head}</b>${status}${shown.length ? html`<ul>${shown}</ul>` : ''}</div>`;
    return html`<div class="pt" role="img" tabindex="${i === buckets.length - 1 ? 0 : -1}" aria-label="${`${head}: ${status}`}" aria-describedby="burn-tip-${i}" style="left:${pct(left)};width:${pct(width)}">${dots}</div>${tip}`;
  });

  const summary = `Burn-up: ${last.done} of ${last.scope} shipped this run as of ${when(t1)}; ${first.scope} in scope when the run started, ${when(t0)}.`;
  const rows = [...points].reverse().map((p) => {
    const changed = p.items.length ? list(p.items.map((it) => change(it)), '; ') : html`<span class="meta">—</span>`;
    return html`<tr><td class="n">${when(p.t)}</td><td class="n">${p.scope}</td><td class="n">${p.done}</td><td class="n">${p.scope - p.done}</td><td>${changed}</td></tr>`;
  });
  return html`<section class="burn"><h2>Burn-up <small>tickets shipped against scope since the run started</small></h2>`
    + html`<div class="chart" role="group" aria-label="${summary}"><div class="bl"><span><i class="ks"></i>Scope</span><span><i class="kd"></i>Shipped</span></div>`
    + html`<div class="plot">${svg}${labels}${ends}${cols}</div>`
    + '<p class="note">Each step is a ticket filed, shipped or closed without shipping. Point at one, or tab to the chart and use the arrow keys, to see which. '
    + 'Tickets filed before the run count from its start; one closed without shipping leaves the scope. Times are Pacific.</p></div>'
    + '<details><summary>The burn-up as a table</summary><div class="tw"><table><thead><tr><th>When</th><th>Scope this run</th><th>Shipped this run</th><th>To go</th><th>What changed</th></tr></thead>'
    + html`<tbody>${rows}</tbody></table></div></details></section>`;
}
