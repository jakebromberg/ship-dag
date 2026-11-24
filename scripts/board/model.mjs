// model.mjs — the status board's pure model: what state each ticket is in, how
// the open tickets order into steps, which wave each is projected to ship in,
// and how refs and times are shown.
//
// Nothing here reads a file or calls `gh`; the CLI gathers the facts and the
// renderer draws them. The step layering is not computed here either: it is
// `planWaves` from plan-waves.mjs (and through it the shared topo core), so the
// board's steps and the engine's waves come from the same math. What is local
// is what neither provides — ancestry, the transitive reduction drawn as edges,
// the longest chain, and the wave projection.

import { planWaves, compareRefString } from '../plan-waves.mjs';
import { parseRef, refKey } from '../lib/ref.mjs';
import { isClosedUndone } from '../eta/state.mjs';

/** Ref order for anything the board sorts: the topo core's, repo then number (`#9` before `#10`). */
export const compareRefs = compareRefString;

/** A closed ticket's board status: `dropped` when closed without shipping (not planned or a duplicate, as the ETA's isClosedUndone), else `shipped`. */
export const closedKind = (stateReason) => (isClosedUndone(stateReason) ? 'dropped' : 'shipped');

/**
 * A ticket's board status, first match wins: closed without shipping → `dropped`;
 * closed → `shipped`; an open closing PR → `flight`; owned by the operator (a
 * release they cut) → `you`; any open blocker → `blocked`; else `ready`.
 *
 * @param {{state:string, stateReason?:string|null, hasOpenPr:boolean, owned:boolean, openBlockers:number}} t
 * @returns {'dropped'|'shipped'|'flight'|'you'|'blocked'|'ready'}
 */
export function classify({ state, stateReason, hasOpenPr, owned, openBlockers }) {
  if (state === 'CLOSED') return closedKind(stateReason);
  if (hasOpenPr) return 'flight';
  if (owned) return 'you';
  return openBlockers > 0 ? 'blocked' : 'ready';
}

/**
 * The open tickets as a layered graph.
 *
 * `steps[i]` holds the tickets that can start once everything in earlier steps
 * has shipped — the layering `planWaves` computes, so a ticket's step is its
 * longest path from a ready ticket. Blockers are read as the engine reads them:
 * one in `done` is satisfied, and an open one outside `openRefs` can never ship
 * this run. So a ticket caught in or behind a cycle (a self-edge included), or
 * waiting on an open blocker outside the set, gets no step and is listed in
 * `unorderable`. `preds` holds only the edges between two open tickets, since
 * only those are drawn; `direct` is its transitive reduction (an edge implied by
 * a longer path is dropped). `chain` is the longest path, end to end. A ref in
 * both `openRefs` and `done` is done, as the engine reads it. `outside` in the
 * result holds the `outside` refs that joined the graph.
 *
 * @param {string[]} openRefs
 * @param {Array<{blocked:string, blockedBy:string}>} edges  any edges; only those into an open ticket count
 * @param {string[]} done  required: closed refs, as the engine's `done[]` (the board's closed members and
 *   closed blockers). Pass `[]` when nothing is closed; a forgotten argument would leave every ticket behind
 *   a closed blocker unorderable, so its absence throws.
 * @param {{outside?: string[]}} [options]  `outside`: open refs that are not run tickets (issue #515)
 */
export function buildGraph(openRefs, edges, done, { outside = [] } = {}) {
  if (!Array.isArray(done)) throw new TypeError('buildGraph: done is required (pass [] when nothing is closed)');
  const closed = new Set(done);
  openRefs = openRefs.filter((r) => !closed.has(r)); // one set for preds, planWaves and the ancestry
  const run = new Set(openRefs);
  const outsideRefs = new Set(outside.filter((r) => !closed.has(r) && !run.has(r)));
  const nodes = [...openRefs, ...outsideRefs];
  const open = new Set(nodes);
  const preds = new Map(nodes.map((r) => [r, new Set()]));
  for (const { blocked, blockedBy } of edges) {
    if (open.has(blocked) && open.has(blockedBy)) preds.get(blocked).add(blockedBy);
  }
  const plan = planWaves({ nodes, edges: edges.filter((e) => open.has(e.blocked)), done });
  const steps = plan.waves.map((w) => [...w]);
  const stepOf = new Map(steps.flatMap((row, i) => row.map((r) => [r, i])));
  const unorderable = new Set([...plan.cyclic, ...plan.blocked.map((b) => b.ref)]);

  // Ancestry over the orderable tickets only; walking steps in order means every
  // predecessor is finished before the ticket that depends on it.
  const ancestors = new Map();
  for (const r of steps.flat()) {
    const out = new Set();
    for (const p of preds.get(r)) { out.add(p); for (const a of ancestors.get(p)) out.add(a); }
    ancestors.set(r, out);
  }
  const descendants = new Map([...ancestors.keys()].map((r) => [r, new Set()]));
  for (const [r, anc] of ancestors) for (const a of anc) descendants.get(a).add(r);
  const direct = new Map([...ancestors.keys()].map((r) => {
    const ps = [...preds.get(r)];
    return [r, new Set(ps.filter((p) => !ps.some((q) => q !== p && ancestors.get(q).has(p))))];
  }));

  return { steps, stepOf, preds, direct, ancestors, descendants, unorderable, outside: outsideRefs, chain: longestChain(steps, stepOf, direct, ancestors, descendants) };
}

/** Deepest ticket (ties: most ancestors, then ref), walked back through the deepest direct parent each time. */
function longestChain(steps, stepOf, direct, ancestors, descendants) {
  const flat = steps.flat();
  if (!flat.length) return [];
  const best = (refs, key) => refs.reduce((a, b) => (compareKeys(key(b), key(a)) > 0 ? b : a));
  const chain = [best(flat, (r) => [stepOf.get(r), ancestors.get(r).size, r])];
  while (direct.get(chain[chain.length - 1]).size) {
    chain.push(best([...direct.get(chain[chain.length - 1])], (r) => [stepOf.get(r), descendants.get(r).size, r]));
  }
  return chain.reverse();
}

/** Compare sort keys element by element: numbers numerically, refs by `compareRefs`. */
function compareKeys(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    const c = typeof a[i] === 'string' ? compareRefs(a[i], b[i]) : a[i] - b[i];
    if (c) return c;
  }
  return 0;
}

/**
 * Order each step's tickets for drawing: the first step by how much each
 * unblocks (most first), every later step by the mean position of its direct
 * parents (barycentre), so most lines run straight down. Ref breaks ties.
 *
 * @param {ReturnType<typeof buildGraph>} g
 * @returns {string[][]}
 */
export function orderSteps(g) {
  const pos = new Map();
  return g.steps.map((row, i) => {
    const key = i === 0
      ? (r) => [-g.descendants.get(r).size, r]
      : (r) => {
        const ps = [...g.direct.get(r)];
        return [ps.length ? ps.reduce((s, p) => s + pos.get(p), 0) / ps.length : 0, r];
      };
    const sorted = [...row].sort((a, b) => compareKeys(key(a), key(b)));
    sorted.forEach((r, j) => pos.set(r, (j + 0.5) / sorted.length));
    return sorted;
  });
}

/**
 * What each predecessor epic shipped before this run, for the "Shipped before this run" section. A leaf counts when
 * `classify` calls it shipped (closed, not without shipping), newest first; one closed without shipping is only counted in
 * `dropped`; an open one is neither. A leaf in `exclude` (the run's own tickets) is left out, and one under several
 * epics counts once, under the first that lists it. An epic with no such leaf is kept, with an empty list.
 *
 * @param {Array<{ref:string,url:string,title:string,leaves:Array<{ref:string,title:string,url:string,state:string,stateReason?:string|null,closedAt?:string|null}>}>} groups
 *   `fetchPredecessors`' result
 * @param {Iterable<string>} [exclude]
 * @returns {Array<{ref:string,url:string,title:string,shipped:Array<object>,dropped:number}>}
 */
export function shippedBefore(groups, exclude = []) {
  const seen = new Set(exclude);
  return groups.map(({ leaves, ...epic }) => {
    const mine = leaves.filter((l) => l.state === 'CLOSED' && !seen.has(l.ref) && seen.add(l.ref));
    const shipped = mine.filter((l) => closedKind(l.stateReason) === 'shipped')
      .sort((a, b) => (b.closedAt || '').localeCompare(a.closedAt || '') || compareRefs(a.ref, b.ref));
    return { ...epic, shipped, dropped: mine.length - shipped.length };
  });
}

/** The GitHub label that makes a run ticket a milestone of its own (a point the operator auditions or signs off). */
export const MILESTONE_LABEL = 'hitl-gate';

/**
 * The run's milestones, in the order they come: reached ones (shipped) oldest first, then open ones in step order
 * (the order `projectWaves` walks), then ones that can't be ordered. A ticket carrying `MILESTONE_LABEL` is one, named
 * by its title; board-notes' `milestones` (`ref → value`) renames one or adds any run ticket with a non-empty string,
 * and suppresses one with `false`; any other value is ignored, as is a ref that is no ticket of the run. A ticket
 * closed without shipping is never one. Each row: `state` (`reached` | `open` | `unorderable`), `before` (the open run
 * tickets among its ancestors), `outside` (the outside nodes among them, sorted), `wave` (the projected wave, or for a
 * reached one the wave it shipped in), and `next`, true on the first open orderable row only.
 *
 * @param {{tickets:Array<{ref:string,title:string,status:string,labels?:string[],closedAt?:string|null,shippedWave?:string}>,
 *   graph:ReturnType<typeof buildGraph>, waves:ReturnType<typeof projectWaves>, notes?:{milestones?:Record<string,unknown>}}} v
 */
export function milestones({ tickets, graph, waves, notes }) {
  const extra = notes?.milestones ?? {};
  const rows = [];
  for (const t of tickets) {
    const note = Object.hasOwn(extra, t.ref) ? extra[t.ref] : undefined;
    const named = typeof note === 'string' && note.trim() ? note.trim() : null;
    if (t.status === 'dropped' || note === false || (!named && !(t.labels ?? []).includes(MILESTONE_LABEL))) continue;
    const reached = t.status === 'shipped';
    const anc = [...(graph.ancestors.get(t.ref) ?? [])];
    rows.push({
      ref: t.ref, name: named ?? t.title, closedAt: t.closedAt,
      state: reached ? 'reached' : graph.stepOf.has(t.ref) ? 'open' : 'unorderable',
      before: anc.filter((r) => !graph.outside.has(r)).length,
      outside: anc.filter((r) => graph.outside.has(r)).sort(compareRefs),
      wave: reached ? { label: t.shippedWave ?? null, now: false } : waves.get(t.ref) ?? null,
    });
  }
  const rank = { reached: 0, open: 1, unorderable: 2 };
  const key = (m) => (m.state === 'open' ? [graph.stepOf.get(m.ref), m.before + m.outside.length] : []);
  rows.sort((a, b) => rank[a.state] - rank[b.state] || (a.closedAt || '').localeCompare(b.closedAt || '')
    || compareKeys(key(a), key(b)) || compareRefs(a.ref, b.ref));
  const next = rows.find((m) => m.state === 'open');
  return rows.map((m) => ({ ...m, next: m === next }));
}

/** The road to a milestone: `ref` and every ancestor of it, outside nodes included; empty for null or an unorderable ref. */
export function roadTo(graph, ref) {
  return graph.stepOf.has(ref) ? new Set([ref, ...graph.ancestors.get(ref)]) : new Set();
}

/** board-notes' `features` map as an object, or `{}` for a value that is not one (an array, a string, null). */
const featureMap = (features) => (features && typeof features === 'object' && !Array.isArray(features) ? features : {});
/** The map's name for `ref`, trimmed, or null when it gives none that is a non-empty string. */
const mapName = (map, ref) => (Object.hasOwn(map, ref) && typeof map[ref] === 'string' && map[ref].trim() ? map[ref].trim() : null);

/** A tracker's title as a section name: the text before the first `: `, ` (` or ` — `, trimmed, or the whole title when that leaves nothing. */
export function trackerName(title) {
  const whole = String(title ?? '').trim();
  return whole.split(/: | \(| — /)[0].trim() || whole;
}

/**
 * A ticket's feature, first match wins: its board-notes `features` entry (a non-empty string, trimmed); else its tracker
 * (the top of its sub-issue parents below the run's epic, `tracker`), named by the map's entry for the tracker's ref or by
 * `trackerName`; else null, for the Other section.
 *
 * @param {{ref:string, tracker?:{ref:string,title:string,url:string}|null}} ticket
 * @param {unknown} features  board-notes' `features`; anything but an object is ignored
 * @returns {{name:string, tracker:{ref:string,url:string}|null}|null}
 */
export function ticketFeature({ ref, tracker }, features) {
  const map = featureMap(features);
  const own = mapName(map, ref);
  if (own) return { name: own, tracker: null };
  if (!tracker) return null;
  return { name: mapName(map, tracker.ref) ?? (trackerName(tracker.title) || tracker.ref), tracker: { ref: tracker.ref, url: tracker.url } };
}

/** The name of the section that holds the tickets with no feature. */
export const OTHER_SECTION = 'Other';

/**
 * The road ahead's sections, one per feature name, from `orderSteps`' rows. Each holds the steps that have any of its
 * tickets, by their run-wide index (`step`), the tickets in the row's order. Sections the map names (a ticket's or a
 * tracker's entry) come first, in the order it first names them; then by earliest step, most tickets, name; Other
 * (`other: true`) last, joined by any feature named like its label. A section links the lowest-ref tracker that named any of
 * its tickets.
 *
 * @param {string[][]} rows  `orderSteps(graph)`
 * @param {(ref:string) => ReturnType<typeof ticketFeature>} featureOf
 * @param {unknown} features  board-notes' `features`, for the order
 * @returns {Array<{name:string, other:boolean, tracker:{ref:string,url:string}|null, rows:Array<{step:number,refs:string[]}>, firstStep:number, size:number}>}
 */
export function featureSections(rows, featureOf, features) {
  const byName = new Map();
  rows.forEach((row, step) => {
    for (const ref of row) {
      const f = featureOf(ref);
      const key = f?.name && f.name !== OTHER_SECTION ? f.name : null; // a name equal to the label would make a second Other
      if (!byName.has(key)) byName.set(key, { name: key ?? OTHER_SECTION, other: key === null, tracker: null, rows: [], firstStep: step, size: 0 });
      const s = byName.get(key);
      if (key !== null && f?.tracker && (!s.tracker || compareRefs(f.tracker.ref, s.tracker.ref) < 0)) s.tracker = f.tracker;
      const last = s.rows[s.rows.length - 1];
      if (last?.step === step) last.refs.push(ref); else s.rows.push({ step, refs: [ref] });
      s.size += 1;
    }
  });
  const map = featureMap(features);
  const rank = new Map();
  for (const ref of Object.keys(map)) { const n = mapName(map, ref); if (n && !rank.has(n)) rank.set(n, rank.size); }
  const at = (s) => rank.get(s.name) ?? Infinity;
  return [...byName.values()].sort((a, b) => a.other - b.other || (at(a) === at(b) ? 0 : at(a) - at(b)) || a.firstStep - b.firstStep
    || b.size - a.size || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The road ahead's sections for a graph: `featureSections` over `orderSteps(graph)`, each ticket's feature by
 * `ticketFeature`. The renderer draws them and `board.mjs` caps the waves by them, so the two never disagree.
 *
 * @param {ReturnType<typeof buildGraph>} graph
 * @param {(ref:string) => {ref:string, tracker?:{ref:string,title:string,url:string}|null}|undefined} ticketOf
 * @param {unknown} features  board-notes' `features`
 */
export function boardSections(graph, ticketOf, features) {
  return featureSections(orderSteps(graph), (r) => ticketFeature(ticketOf(r) ?? { ref: r }, features), features);
}

/** Each ref of `sections` → its section's index, which is its priority. */
export const sectionIndex = (sections) => new Map(sections.flatMap((s, k) => s.rows.flatMap(({ refs }) => refs.map((r) => [r, k]))));

/** The number a wave id starts with: `"31b"` → 31, `"1′"` → 1, none → 0. */
export function leadingWaveNumber(id) {
  const m = /^(\d+)/.exec(String(id ?? ''));
  return m ? Number(m[1]) : 0;
}

/** The most features the wave projection lets be in flight at once (the owner's rule for working the queue). */
export const FEATURES_IN_FLIGHT = 2;

/**
 * Project the wave each open, orderable ticket ships in. A ticket in the wave
 * building now is that wave (its id, verbatim — `"31b"`); any other ticket goes
 * one after the latest wave among its blockers, counting from the current
 * wave's leading number; a ticket with an open PR is building now too, when there is a current wave. An `outside` node (an open issue of another run, issue #515) is one wave of
 * its home run: the current wave when nothing open precedes it, else one after its blockers; it takes no
 * label (`outside: true`), and the run ticket behind it goes one after that. A ticket of the operator's (`status: "you"`) takes no
 * wave, and what waits on it goes after *its* blockers. The projection assumes
 * each wave ships before the next starts. A wave has no width limit.
 *
 * With `sectionOf` (ref → road-ahead section index, `sectionIndex(boardSections(…))`, the index being the section's
 * priority), at most `limit` features are in flight (issue #562): a wave takes every ready ticket of an admitted feature,
 * and while a slot is free it admits the highest-priority feature with a ready ticket; a feature leaves once none of
 * its tickets is projected at or after the wave being filled. The features of the tickets building now (the current
 * wave's, and any with an open PR, which count as building now in either mode) start admitted, however many; a ticket of
 * yours or an outside node building now admits nothing, and a feature whose current-wave tickets have all shipped (so
 * only open tickets are in the graph) is not admitted at the start: it competes for a slot like any other. An
 * admitted feature with no ready ticket of its own gives its slot to the ready blockers of one other feature that its
 * open tickets wait on, without admitting that feature, so two features waiting on a third still finish and a wave
 * never opens a third feature. Outside nodes and tickets of yours are not capped.
 *
 * @param {ReturnType<typeof buildGraph>} g
 * @param {Map<string,string>} status  ref → classify() result
 * @param {{id:string, refs:Set<string>}|null} current  the wave building now, if any
 * @param {{sectionOf?: Map<string,number>|null, limit?: number}} [options]
 * @returns {Map<string,{label:string|null, now:boolean, outside?:true}>}
 */
export function projectWaves(g, status, current, { sectionOf = null, limit = FEATURES_IN_FLIGHT } = {}) {
  const cur = current ? leadingWaveNumber(current.id) : 0;
  const eff = new Map();
  const out = new Map();
  const order = g.steps.flat(); // step order: every blocker comes first
  // An open PR is being built, whatever wave launched it; with no current wave it keeps its old wave, one after its blockers.
  const now = (r) => !!current && (current.refs.has(r) || status.get(r) === 'flight');
  const fixed = (r) => g.outside.has(r) || status.get(r) === 'you' || now(r);
  const capped = (r) => !!sectionOf?.has(r) && !fixed(r);
  const after = (r) => { const ps = [...g.preds.get(r)]; return ps.length ? Math.max(...ps.map((p) => eff.get(p))) : null; };
  const place = (r, wave, label) => { eff.set(r, wave); out.set(r, label); };
  const pending = new Set(order);
  const settle = () => { // every uncapped ticket whose blockers are all projected, in step order
    for (const r of order) {
      if (!pending.has(r) || capped(r) || ![...g.preds.get(r)].every((p) => eff.has(p))) continue;
      const base = after(r);
      if (g.outside.has(r)) place(r, base === null ? cur : base + 1, { label: null, now: false, outside: true });
      else if (status.get(r) === 'you') place(r, base ?? cur, { label: null, now: false });
      else if (now(r)) place(r, cur, { label: String(current.id), now: true });
      else place(r, (base ?? cur) + 1, { label: String((base ?? cur) + 1), now: false });
      pending.delete(r);
    }
  };
  settle();
  const counts = (r) => !!sectionOf?.has(r) && !g.outside.has(r) && status.get(r) !== 'you'; // a run ticket the cap weighs
  const members = new Map(); // section → its run tickets that count toward its being in flight
  for (const r of order) {
    if (!counts(r)) continue;
    members.set(sectionOf.get(r), [...(members.get(sectionOf.get(r)) ?? []), r]);
  }
  const admitted = new Set(order.filter((r) => now(r) && counts(r)).map((r) => sectionOf.get(r)));
  for (let w = cur + 1; order.some((r) => pending.has(r) && capped(r)); w += 1) {
    if (w > cur + 2 * order.length + 2) throw new Error('projectWaves: the feature cap left tickets unplaced'); // a bug, never a slow wave
    for (const s of admitted) if (members.get(s).every((r) => eff.has(r) && eff.get(r) < w)) admitted.delete(s);
    const ready = order.filter((r) => pending.has(r) && capped(r) && [...g.preds.get(r)].every((p) => eff.has(p) && eff.get(p) < w));
    for (const s of [...new Set(ready.map((r) => sectionOf.get(r)))].sort((a, b) => a - b)) {
      if (admitted.size >= limit) break;
      admitted.add(s);
    }
    // Each admitted feature's slot takes its own ready tickets or, with none, the ready blockers of one other feature
    // that its open tickets wait on, so a pulled-in blocker never opens a third feature.
    const wave = [];
    for (const s of [...admitted].sort((a, b) => a - b)) {
      const own = ready.filter((r) => sectionOf.get(r) === s);
      if (own.length) { wave.push(...own); continue; }
      const needed = new Set(members.get(s).filter((r) => pending.has(r)).flatMap((r) => [...g.ancestors.get(r)]));
      const blockers = ready.filter((r) => needed.has(r) && !admitted.has(sectionOf.get(r)));
      const first = Math.min(...blockers.map((r) => sectionOf.get(r)));
      wave.push(...blockers.filter((r) => sectionOf.get(r) === first && !wave.includes(r)));
    }
    for (const r of wave) {
      place(r, w, { label: String(w), now: false });
      pending.delete(r);
    }
    settle();
  }
  return out;
}

/**
 * A function that labels an `owner/repo` for display: an explicit abbreviation
 * for the repo if one is given, else the bare repo name — unless two owners
 * share that name, when only `owner/repo` is unambiguous. Repos match as GitHub
 * compares them, ignoring case.
 *
 * @param {Iterable<string>} repos  every `owner/repo` the board shows
 * @param {Record<string,string>} [abbreviations]  `owner/repo` → label
 * @returns {(repo:string) => string}
 */
export function makeRepoLabel(repos, abbreviations = {}) {
  const abbr = new Map(Object.entries(abbreviations).map(([repo, label]) => [refKey(repo), label]));
  const owners = new Map();
  for (const repo of repos) {
    const name = refKey(repo.split('/')[1]);
    owners.set(name, (owners.get(name) || new Set()).add(refKey(repo)));
  }
  return (repo) => {
    if (abbr.has(refKey(repo))) return abbr.get(refKey(repo));
    const name = repo.split('/')[1];
    return owners.get(refKey(name))?.size > 1 ? repo : name;
  };
}

/**
 * A function that shortens `owner/repo#N` for display, its repo labelled as
 * `makeRepoLabel` labels it. Anything that is not an `owner/repo#N` ref is
 * shown as given.
 *
 * @param {Iterable<string>} repos  every `owner/repo` the board shows
 * @param {Record<string,string>} [abbreviations]  `owner/repo` → label
 * @returns {(ref:string) => string}
 */
export function makeShortRef(repos, abbreviations = {}) {
  const label = makeRepoLabel(repos, abbreviations);
  return (ref) => {
    const parsed = parseRef(ref);
    return parsed ? `${label(parsed.repo)}#${parsed.number}` : ref;
  };
}

const PACIFIC = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

/**
 * An instant in Pacific time, always with its zone label (PDT or PST, chosen by
 * the date), or '' for a missing or invalid one. `long` adds the weekday. Assembled from parts so the punctuation
 * doesn't vary with the ICU version.
 *
 * @param {string|null|undefined} iso
 * @param {'long'|'short'} [style]
 */
export function formatPacific(iso, style = 'short') {
  const date = new Date(iso ?? NaN);
  if (Number.isNaN(date.getTime())) return '';
  const p = Object.fromEntries(PACIFIC.formatToParts(date).map(({ type, value }) => [type, value]));
  const s = `${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`;
  return style === 'long' ? `${p.weekday} ${s}` : s;
}
