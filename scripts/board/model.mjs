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
import { CLOSED_UNDONE } from '../eta/state.mjs';

/** Ref order for anything the board sorts: the topo core's, repo then number (`#9` before `#10`). */
export const compareRefs = compareRefString;

/** A closed ticket's board status: `dropped` when closed without shipping (not planned or a duplicate, as the ETA's CLOSED_UNDONE), else `shipped`. */
export const closedKind = (stateReason) => (CLOSED_UNDONE.has(stateReason) ? 'dropped' : 'shipped');

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
 * both `openRefs` and `done` is done, as the engine reads it.
 *
 * @param {string[]} openRefs
 * @param {Array<{blocked:string, blockedBy:string}>} edges  any edges; only those into an open ticket count
 * @param {string[]} done  required: closed refs, as the engine's `done[]` (the board's closed members and
 *   closed blockers). Pass `[]` when nothing is closed; a forgotten argument would leave every ticket behind
 *   a closed blocker unorderable, so its absence throws.
 */
export function buildGraph(openRefs, edges, done) {
  if (!Array.isArray(done)) throw new TypeError('buildGraph: done is required (pass [] when nothing is closed)');
  const closed = new Set(done);
  openRefs = openRefs.filter((r) => !closed.has(r)); // one set for preds, planWaves and the ancestry
  const open = new Set(openRefs);
  const preds = new Map(openRefs.map((r) => [r, new Set()]));
  for (const { blocked, blockedBy } of edges) {
    if (open.has(blocked) && open.has(blockedBy)) preds.get(blocked).add(blockedBy);
  }
  const plan = planWaves({ nodes: openRefs, edges: edges.filter((e) => open.has(e.blocked)), done });
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

  return { steps, stepOf, preds, direct, ancestors, descendants, unorderable, chain: longestChain(steps, stepOf, direct, ancestors, descendants) };
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

/** The number a wave id starts with: `"31b"` → 31, `"1′"` → 1, none → 0. */
export function leadingWaveNumber(id) {
  const m = /^(\d+)/.exec(String(id ?? ''));
  return m ? Number(m[1]) : 0;
}

/**
 * Project the wave each open, orderable ticket ships in. A ticket in the wave
 * building now is that wave (its id, verbatim — `"31b"`); any other ticket goes
 * one after the latest wave among its blockers, counting from the current
 * wave's leading number. A ticket of the operator's (`status: "you"`) takes no
 * wave, and what waits on it goes after *its* blockers. The projection assumes
 * each wave ships before the next starts.
 *
 * @param {ReturnType<typeof buildGraph>} g
 * @param {Map<string,string>} status  ref → classify() result
 * @param {{id:string, refs:Set<string>}|null} current  the wave building now, if any
 * @returns {Map<string,{label:string|null, now:boolean}>}
 */
export function projectWaves(g, status, current) {
  const cur = current ? leadingWaveNumber(current.id) : 0;
  const eff = new Map();
  const out = new Map();
  for (const r of g.steps.flat()) { // step order: every blocker is projected first
    const ps = [...g.preds.get(r)];
    const base = ps.length ? Math.max(...ps.map((p) => eff.get(p))) : null;
    if (status.get(r) === 'you') {
      eff.set(r, base ?? cur);
      out.set(r, { label: null, now: false });
    } else if (current && current.refs.has(r)) {
      eff.set(r, cur);
      out.set(r, { label: String(current.id), now: true });
    } else {
      eff.set(r, (base ?? cur) + 1);
      out.set(r, { label: String(eff.get(r)), now: false });
    }
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
