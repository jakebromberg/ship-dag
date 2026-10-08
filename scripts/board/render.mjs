// render.mjs — the status board page, as one self-contained HTML string.
//
// Pure: the caller hands in every fact (tickets, the graph from model.mjs, the
// projected waves, the notes) and the current time, and gets a page back. Every
// interpolated string goes through `esc`, notes included; every time is Pacific
// with its zone label. The stylesheet and road-ahead script are inlined from
// assets.mjs so the page needs nothing beside it.

import { orderSteps, formatPacific } from './model.mjs';
import { PAGE_CSS, ROAD_JS } from './assets.mjs';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Status → the CSS token its bar segment and swatch use, in legend order. */
const BAR_TOKEN = { shipped: 'ship', flight: 'flight', ready: 'ready', you: 'block', blocked: 'queued' };
const LEGEND = [['ship', 'Shipped'], ['flight', 'PR open'], ['ready', 'Ready to start'], ['block', 'Waiting on you'], ['queued', 'Waiting on other tickets']];
const CHIP = { you: 'Yours', ready: 'Ready', blocked: 'Waiting', flight: 'PR open' };

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
 * @param {{callouts?:Array<{owner?:string,title:string,text?:string,html?:string}>, wave?:string, gates?:Record<string,string>}} v.notes
 * @param {string} v.rebuild  the command that rebuilds this page
 * @returns {string}
 */
export function renderBoard(v) {
  const byRef = new Map(v.tickets.map((t) => [t.ref, t]));
  const link = (ref, label) => `<a href="${esc(byRef.get(ref)?.url || '')}">${esc(label || v.shortRef(ref))}</a>`;
  const prLinks = (t, only) => t.prs.filter((p) => only.includes(p.state))
    .map((p) => `<a class="pr pr-${esc(p.state)}" href="${esc(p.url)}" title="${esc(p.state)}">#${esc(p.number)}</a>`).join(' ');
  const counts = {};
  for (const t of v.tickets) counts[t.status] = (counts[t.status] || 0) + 1;
  const total = v.tickets.length - (counts.dropped || 0);
  const notes = v.notes || {};

  const h = [`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta http-equiv="refresh" content="120"><title>${esc(v.title)}</title><style>${PAGE_CSS}</style></head><body><main>`];
  h.push(`<h1>${esc(v.title)}</h1>`
    + (v.scope ? `<p class="sub"><a href="${esc(v.scope.url)}">${esc(v.scope.label)}</a> — ${esc(v.scope.title)}</p>` : '')
    + `<p class="meta">Updated ${esc(formatPacific(v.now, 'long'))} · run ${esc(v.runId)} · reloads every 2 minutes</p>`);
  h.push(`<div class="tiles">${[
    [`${counts.shipped || 0}/${total}`, 'shipped'], [counts.flight || 0, 'PR open'], [counts.ready || 0, 'ready to start'],
    [counts.you || 0, 'waiting on you'], [counts.blocked || 0, 'waiting on other tickets'],
  ].map(([n, l]) => `<div class="tile"><b>${esc(n)}</b><span>${l}</span></div>`).join('')}</div>`);
  h.push(bar(counts, total));
  h.push(`<div class="legend">${LEGEND.map(([c, l]) => `<span><i style="background:var(--${c})"></i>${l}</span>`).join('')}</div>`);
  h.push(repoBars(v.tickets));

  if (notes.callouts?.length) {
    h.push(`<h2>Needs attention</h2><div class="callouts">${notes.callouts.map((c) => `<div class="callout${c.owner === 'you' ? ' you' : ''}">`
      + `<b>${esc(c.title)}</b>${esc(c.text ?? c.html)}</div>`).join('')}</div>`);
  }

  const flight = v.tickets.filter((t) => t.status === 'flight').sort((a, b) => a.ref.localeCompare(b.ref));
  const defaultSubtitle = v.current ? `wave ${v.current.id}` : '';
  h.push(`<h2>In flight <small>${esc(notes.wave || defaultSubtitle)}</small></h2>`);
  h.push(flight.length
    ? `<div class="cards">${flight.map((t) => `<div class="card"><div class="top">${link(t.ref)}<span class="chip c-flight">${esc(t.stage || 'PR open')}</span></div>`
      + `<div class="t">${esc(t.title)}</div><div>${prLinks(t, ['open', 'merged'])}</div>`
      + (t.note ? `<div class="note">${esc(t.note)}</div>` : '') + '</div>').join('')}</div>`
    : '<p class="sub">No PR open right now.</p>');
  const just = v.current ? v.tickets.filter((t) => t.status === 'shipped' && v.current.refs.has(t.ref)) : [];
  if (just.length) {
    h.push(`<p class="meta" style="margin-top:10px">Shipped this wave: ${just.map((t) => `${link(t.ref)} ${prLinks(t, ['merged'])}`).join(', ')}</p>`);
  }

  h.push('<h2>Road ahead <small>every open ticket, in dependency order</small></h2>');
  h.push(roadAhead(v, byRef, link, notes.gates || {}));

  const shipped = v.tickets.filter((t) => t.status === 'shipped').sort((a, b) => (b.closedAt || '').localeCompare(a.closedAt || ''));
  h.push(`<h2>Shipped <small>${shipped.length} tickets, newest first</small></h2><details><summary>Show all ${shipped.length}</summary>`
    + '<div class="tw"><table><thead><tr><th>Ticket</th><th>Title</th><th>PR</th><th>Wave</th><th>Closed</th></tr></thead><tbody>'
    + shipped.map((t) => `<tr><td class="n">${link(t.ref)}</td><td>${esc(t.title)}</td><td class="n">${prLinks(t, ['merged']) || '<span class="meta">—</span>'}</td>`
      + `<td class="n">${esc(t.shippedWave || '')}</td><td class="n">${esc(formatPacific(t.closedAt))}</td></tr>`).join('')
    + '</tbody></table></div></details>');
  const dropped = v.tickets.filter((t) => t.status === 'dropped');
  if (dropped.length) {
    h.push(`<details><summary>Closed as not planned (${dropped.length})</summary><div class="items">${dropped.map((t) => `<span class="item">${link(t.ref)} <span class="x">${esc(t.title)}</span></span>`).join('')}</div></details>`);
  }
  h.push(`<footer>Times are Pacific. Rebuild with <code>${esc(v.rebuild)}</code>. Built from GitHub, the run's engine state, its review files and telemetry, and its board notes. Local file, not committed.</footer></main>`
    + `<script>${ROAD_JS}</script></body></html>`);
  return h.join('\n');
}

function bar(counts, total) {
  const segs = Object.entries(BAR_TOKEN).filter(([k]) => counts[k]).map(([k, c]) => `<i style="flex:${counts[k]};background:var(--${c})"></i>`).join('');
  return `<div class="bar" role="img" aria-label="${counts.shipped || 0} of ${total} shipped">${segs}</div>`;
}

function repoBars(tickets) {
  const repos = new Map();
  for (const t of tickets) {
    if (t.status === 'dropped') continue;
    const repo = t.ref.split('#')[0];
    const c = repos.get(repo) || {};
    c[t.status] = (c[t.status] || 0) + 1;
    repos.set(repo, c);
  }
  const size = (c) => Object.values(c).reduce((a, b) => a + b, 0);
  return `<div class="repos">${[...repos].sort((a, b) => size(b[1]) - size(a[1])).map(([repo, c]) => `<div class="repo"><b>${esc(repo.split('/')[1])}</b> · `
    + `${c.shipped || 0}/${size(c)} shipped${bar(c, size(c))}</div>`).join('')}</div>`;
}

function roadAhead(v, byRef, link, gates) {
  const g = v.graph;
  const h = [];
  if (g.unorderable.size) {
    h.push(`<div class="callouts"><div class="callout you"><b>Can't be ordered</b>These tickets are in a dependency cycle, or wait behind one, so no step can start them: `
      + `${[...g.unorderable].sort().map((r) => link(r)).join(', ')}.</div></div>`);
  }
  if (!g.steps.length) return [...h, '<p class="sub">Nothing left open.</p>'].join('\n');
  const rows = orderSteps(g);
  const chain = new Set(g.chain);
  const chainEdges = new Set(g.chain.slice(1).map((r, i) => `${g.chain[i]}>${r}`));
  const status = (r) => byRef.get(r)?.status;
  const wave = (r) => v.waves.get(r) || { label: null, now: false };
  const waveText = (r) => (wave(r).label === null ? 'Yours, not an engine wave' : `Wave ${wave(r).label}${wave(r).now ? ' · building now' : ''}`);
  const rowWaves = (row) => {
    const labels = [...new Set(row.map((r) => wave(r).label).filter((l) => l !== null))];
    const yours = row.some((r) => wave(r).label === null) ? ' + yours' : '';
    if (!labels.length) return 'yours';
    return (labels.length === 1 ? `wave ${labels[0]}` : `waves ${labels[0]}–${labels[labels.length - 1]}`) + yours;
  };
  const count = g.steps.flat().length;
  h.push(`<p class="road-sum"><b>${count} tickets left, in ${rows.length} steps.</b> A step is the earliest a ticket can start: once every ticket it points up to has shipped. Tickets in the same step can be built at the same time.</p>`);
  h.push(`<p class="howto"><b>Waves</b> continue the run's count.${v.current ? ` Wave ${esc(v.current.id)} is building now;` : ''} the later numbers are a projection that assumes each wave ships before the next starts. `
    + 'A ticket moves to a later wave if review sends it back, or if a wave launches without it. A ticket of yours, such as a release you cut, takes no wave: what waits on it goes in the next wave after you finish it.</p>');
  h.push(`<div class="path"><span class="meta" style="margin:0">Longest chain:</span>${g.chain.map((r) => link(r)).join('<span class="arr">→</span>')}`
    + `<span class="meta" style="margin:0">(${g.chain.length} tickets, one after another)</span></div>`);
  h.push('<p class="howto">Lines show direct dependencies only; one implied by a longer chain is left out. The blue chain is the longest one: nothing finishes before it does. Hover or tab to a ticket to trace everything it waits on and everything waiting on it.</p>');
  const edges = rows.flat().flatMap((r) => [...g.direct.get(r)].sort().map((p) => [p, r, chainEdges.has(`${p}>${r}`)]));
  h.push(`<div class="dag" id="dag" data-edges="${esc(JSON.stringify(edges))}"><svg aria-hidden="true"></svg>`);
  rows.forEach((row, i) => {
    h.push(`<div class="row"><div class="lab"><b>Step ${i + 1}</b><span class="wv">${esc(rowWaves(row))}</span>${row.length} ticket${row.length === 1 ? '' : 's'} · ${i === 0 ? 'can start now' : 'waits on earlier steps'}</div><div class="ns">`);
    for (const r of row) {
      const t = byRef.get(r) || { title: '' };
      const st = status(r);
      const after = [...g.direct.get(r)].sort((a, b) => g.stepOf.get(a) - g.stepOf.get(b) || a.localeCompare(b)).map((p) => v.shortRef(p)).join(', ');
      const desc = g.descendants.get(r);
      h.push(`<div class="node s-${esc(st)}${chain.has(r) ? ' crit' : ''}" tabindex="0" data-ref="${esc(r)}" `
        + `data-anc="${esc([...g.ancestors.get(r)].sort().join(' '))}" data-desc="${esc([...desc].sort().join(' '))}">`
        + `<div class="top">${link(r)}<span class="chip c-${esc(st)}">${esc(t.stage || CHIP[st] || st)}</span></div>`
        + `<div class="t" title="${esc(t.title)}">${esc(t.title)}</div>`
        + `<div class="wn${wave(r).now ? ' now' : ''}">${esc(waveText(r))}</div>`
        + (gates[r] ? `<div class="gate">Needs: ${esc(gates[r])}</div>` : '')
        + `<div class="dep">${after ? `after ${esc(after)}` : 'nothing open before it'}</div>`
        + `<div class="dep">${desc.size ? `unblocks ${desc.size}` : 'nothing waits on it'}</div></div>`);
    }
    h.push('</div></div>');
  });
  h.push('</div>');
  h.push('<details><summary>Order of work as a table</summary><div class="tw"><table><thead><tr><th>Step</th><th>Wave</th><th>Ticket</th><th>Title</th><th>Waits on</th><th>Unblocks</th></tr></thead><tbody>');
  rows.forEach((row, i) => {
    for (const r of row) {
      h.push(`<tr><td class="n">${i + 1}</td><td class="n">${esc(wave(r).label ?? 'yours')}</td><td class="n">${link(r)}</td><td>${esc(byRef.get(r)?.title)}</td>`
        + `<td>${[...g.direct.get(r)].sort().map((p) => link(p)).join(', ') || '—'}</td><td class="n">${g.descendants.get(r).size}</td></tr>`);
    }
  });
  h.push('</tbody></table></div></details>');
  return h.join('\n');
}
