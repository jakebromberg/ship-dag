#!/usr/bin/env node
// plan-waves.mjs — deterministic DAG math for /ship-dag.
//
// The LLM must not be trusted to topologically sort a dependency graph in its
// head, so all wave/ready-set computation lives here as pure, tested functions.
// The gh-fetching wrapper builds a spec; the pure functions partition it.
//
// The graph math itself is NOT reimplemented here — it delegates to the shared
// composite-keyed topological-sort core in claude-orchestrator (`readySet` /
// `layeredTopoSort` from `<CO_HOME>/dist/src/index.js`), so this planner and the
// engine's `computeWaves` can never drift. This file owns only the ship-dag
// specifics: the gh-fetch wrapper, the recursive sub-issue walk and the
// container-edge rewriting it requires, body-prose edge parsing, spec→core
// conversion, and the human-readable table. Set `CO_HOME` to your claude-orchestrator
// checkout (default `/Users/me/Developer/claude-orchestrator`); the core must
// be built (`npm run build` there — `dist/` is committed, so a fresh checkout
// already has it).
//
// Everything is keyed on composite *refs* — `"owner/repo#12"` when a repo is
// known, or a bare `"12"` in single-repo back-compat — so the same issue number
// in two repos stays two distinct nodes and a cross-repo dependency edge is
// honored. A bare number or `#N` in a spec/body is qualified against the spec's
// default `repo` (for a node) or the citing issue's repo (for a body edge).
//
// Spec shape (JSON):
//   {
//     "repo":  "owner/repo",                                 // default repo for bare refs
//     "nodes": [{ "number": 3, "ref": "owner/repo#3", "repo": "owner/repo",
//                 "title": "...", "labels": [...], "bodyLen": 1200, "refCount": 2 }, ...],
//     "edges": [{ "blocked": "owner/repo#3", "blockedBy": "owner/repo#1" }, ...],
//     "done":  ["owner/repo#1", "owner/repo#2"],             // already merged/closed
//     "members": ["owner/repo#1", "owner/repo#3", ...]       // fetch --members only: every leaf in scope, closed included
//   }
//   `members` is for the status board (see `fetchSpec`); planning ignores it.
//   Edge endpoints and `done` entries may be a number, `"#N"`, `"N"`, or a
//   fully-qualified `"owner/repo#N"`; all are normalized to refs before planning.
//
// Usage:
//   node plan-waves.mjs plan <spec.json|->      # partition a spec into waves (stdin with -)
//   node plan-waves.mjs fetch --repo owner/repo (--epic N | --label L) [--members]   # build a spec via gh
//   node plan-waves.mjs fetch ... > spec.json && node plan-waves.mjs plan spec.json
//   node plan-waves.mjs fetch ... | node plan-waves.mjs plan -           # or composed
//
// `plan` prints { waves, blocked, cyclic } as JSON (refs) plus a human-readable table.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { coDistPath } from './lib/co-home.mjs';
import { isMain } from './lib/is-main.mjs';
import { SubIssuesUnavailable, listSubIssues, hasWaveLabel, hasSubIssues, subIssueRepo } from './lib/sub-issues.mjs';
import { realRunGh } from './lib/gh.mjs';
import { stringOption } from './lib/cli-args.mjs';

const LIST_LIMIT = 1000; // gh issue list cap; we warn if we hit it rather than truncate silently.

// ---- shared topo core (single source of truth for the graph math) --------

const CORE_ENTRY = resolve(coDistPath(process.env, 'index.js'));

let core;
try {
  core = await import(pathToFileURL(CORE_ENTRY).href);
} catch (err) {
  throw new Error(
    `ship-dag: could not load the shared topo core from ${CORE_ENTRY}. `
    + `Set CO_HOME to your claude-orchestrator checkout and build it (\`npm run build\`). `
    + `Underlying error: ${err.message}`,
  );
}
const { readySet: coreReadySet, layeredTopoSort, refOf, normalizeDep, repoOfRef } = core;

/** The core's ref order (repo, then number, so `#9` before `#10`), the tie-break its waves use. */
export const { compareRefString } = core;

// ---- spec → core conversion ---------------------------------------------

/**
 * Normalize any endpoint (number, `"N"`, `"#N"`, or `"owner/repo#N"`) to a ref,
 * qualifying bare forms against `defaultRepo`. Thin wrapper over the core's
 * `normalizeDep` with a repo-less citing stub, so both planners resolve refs
 * identically.
 */
function toRef(endpoint, defaultRepo) {
  return normalizeDep(endpoint, { number: 0 }, defaultRepo || undefined);
}

/** The ref of a spec node — its explicit `ref`, else `repo#number` against the default. */
function nodeRef(n, defaultRepo) {
  if (typeof n === 'number' || typeof n === 'string') return toRef(n, defaultRepo);
  if (n.ref) return n.ref;
  return refOf({ number: n.number, repo: n.repo }, defaultRepo || undefined);
}

/** Build the core's `TopoNode[]` (`{ref, deps}`) from a ship-dag spec. */
function toTopoNodes({ repo, nodes = [], edges = [] }) {
  const refs = nodes.map((n) => nodeRef(n, repo));
  const depsOf = new Map(refs.map((r) => [r, []]));
  for (const { blocked, blockedBy } of edges) {
    const b = toRef(blocked, repo);
    if (depsOf.has(b)) depsOf.get(b).push(toRef(blockedBy, repo));
  }
  return refs.map((ref) => ({ ref, deps: depsOf.get(ref) }));
}

function toDoneRefs({ repo, done = [] }) {
  return done.map((d) => toRef(d, repo));
}

/**
 * Ready-set for the current `done` frontier: open nodes whose every dependency
 * is already satisfied. Nodes with a dependency that can never be satisfied
 * (not in scope and not done) are reported as externally blocked. Delegates the
 * math to the shared core after converting the spec to composite refs.
 *
 * @param {{repo?:string, nodes: Array<{number?:number,ref?:string,repo?:string}>|Array<number|string>, edges?: Array<{blocked:number|string,blockedBy:number|string}>, done?: Array<number|string>}} spec
 * @returns {{ready:string[], blockedExternally:Array<{ref:string,missing:string[]}>}}
 */
export function readySet(spec) {
  return coreReadySet(toTopoNodes(spec), toDoneRefs(spec));
}

/**
 * Layered topological partition. `waves[i]` is the set of refs that become
 * shippable once every earlier wave has merged. Anything that never becomes
 * ready is reported as `blocked` (a dependency outside the DAG that is not done,
 * `reason:"external"`; or a node transitively blocked behind a dropped one,
 * `reason:"unreachable"`) or, if stuck on a dependency cycle with no external
 * cause, in `cyclic`. Delegates the math to the shared core.
 *
 * @param {{repo?:string, nodes: Array<{number?:number,ref?:string,repo?:string}>|Array<number|string>, edges?: Array<{blocked:number|string,blockedBy:number|string}>, done?: Array<number|string>}} spec
 * @returns {{waves:string[][], blocked:Array<{ref:string,reason:string,missing:string[]}>, cyclic:string[]}}
 */
export function planWaves(spec) {
  return layeredTopoSort(toTopoNodes(spec), { done: toDoneRefs(spec) });
}

// ---- body-prose edge parsing --------------------------------------------

// A single reference token: bare `#12` or cross-repo `owner/repo#12`.
const REF_TOKEN = '(?:[\\w.-]+/[\\w.-]+)?#\\d+';
// A contiguous "#a, owner/repo#b and #c" run of them.
const REF_LIST = `${REF_TOKEN}(?:\\s*(?:,|and)\\s*${REF_TOKEN})*`;
// A heading line that opens a "Blocked by" / "Depends on" bulleted list: an
// optional markdown `#` prefix, the phrase, then any trailing text that is NOT
// a ref — a colon, a count ("### Blocked by (2)"), a parenthetical note. A ref
// on the same line (`#` present) means the adjacent-clause form the first pass
// already handles, so `[^#]` excludes it and this heading pass stays out of the
// way.
const DEP_HEADING_RE = /^#{0,6}\s*(?:blocked by|depends on)\b[^#]*$/i;
// A markdown bullet line: "- " or "* " followed by the rest (the ref plus any
// "— annotation").
const BULLET_RE = /^\s*[-*]\s+(.*)$/;
// An already-resolved annotation on a heading-list bullet ("#877 — RESOLVED,
// merged in #900") — a stale reference to a since-closed blocker, not a live
// edge, so its bullet is skipped rather than emitted. The marker must follow a
// dash separator ("— RESOLVED", " - resolved"); a bare occurrence of the word
// in a bullet's prose ("blocks the resolved-tickets view") is NOT a status
// marker, and skipping such a live blocker is the dangerous direction.
const RESOLVED_RE = /[-—–]\s*resolved\b/i;

/**
 * Extract dependency edges from an issue body. Handles multi-issue clauses
 * ("Blocked by #12, #13 and #14"), the reverse direction ("Blocks #20"), and
 * cross-repo references ("Blocked by owner/repo#3") — refs adjacent to the
 * phrase, all on one line. Also handles the common heading-plus-bulleted-list
 * layout, where the refs live one per bullet under their own heading line:
 *   ## Blocked by
 *   - WXYC/Backend-Service#877 — Epic C …
 *   - WXYC/Backend-Service#878 — Epic D …
 * A blank line between the heading and its first bullet (the markdownlint-
 * standard layout) is skipped; once the list has started, a blank line or a
 * non-bullet line (typically the next heading) ends it. A bullet annotated as
 * already resolved ("— RESOLVED …") is skipped since it no longer names a live
 * blocker. Bare `#N` refs are qualified to the citing issue's own repo;
 * `owner/repo#N` refs are kept as-is. Output is deduped on the `blocked
 * |blockedBy` pair, since the adjacent-clause and heading-list forms can name
 * the same edge. Pure — no I/O — so it is unit-tested directly.
 *
 * @param {number|{number:number,repo?:string}} citing  the issue the body belongs to
 * @param {string} body
 * @returns {Array<{blocked:string,blockedBy:string}>}  endpoints are composite refs
 */
export function bodyEdges(citing, body) {
  const cite = typeof citing === 'number' ? { number: citing } : citing;
  const selfRef = refOf({ number: cite.number, repo: cite.repo });
  const text = body || '';
  const edges = [];
  const tokens = new RegExp(REF_TOKEN, 'g');
  // Forward: this issue depends on those (adjacent-clause form).
  for (const m of text.matchAll(new RegExp(`(?:blocked by|depends on)\\s+(${REF_LIST})`, 'gi'))) {
    for (const r of m[1].matchAll(tokens)) {
      edges.push({ blocked: selfRef, blockedBy: normalizeDep(r[0], cite) });
    }
  }
  // Reverse: this issue must precede those ("Blocks #20"). "blocked" won't match "blocks\s".
  for (const m of text.matchAll(new RegExp(`\\bblocks\\s+(${REF_LIST})`, 'gi'))) {
    for (const r of m[1].matchAll(tokens)) {
      edges.push({ blocked: normalizeDep(r[0], cite), blockedBy: selfRef });
    }
  }
  // Forward: a "Blocked by" / "Depends on" heading followed by a bulleted list.
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!DEP_HEADING_RE.test(lines[i].trim())) continue;
    let started = false;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (!line.trim()) {
        if (started) break; // a blank line after the list has begun ends it
        continue; // a leading blank between heading and first bullet is skipped
      }
      const bullet = line.match(BULLET_RE);
      if (!bullet) break; // non-bullet line (e.g. the next heading) ends the list
      started = true;
      if (RESOLVED_RE.test(bullet[1])) continue; // stale bullet — no live edge
      for (const r of bullet[1].matchAll(tokens)) {
        edges.push({ blocked: selfRef, blockedBy: normalizeDep(r[0], cite) });
      }
    }
  }
  return dedupeEdges(edges);
}

/**
 * Native GitHub issue-dependency ("blocked by") edges for one node, in the same
 * `{blocked, blockedBy}` ref shape `bodyEdges` emits. This is a separate feature
 * from body prose — many issues declare a blocker through the dependency graph
 * without ever mentioning it in text, and missing that edge is the dangerous
 * failure direction (a genuinely-blocked issue reported as ready). Tolerates a
 * repo where native dependencies aren't configured, or aren't visible to the
 * token: any failure yields no edges rather than aborting the fetch — mirroring
 * how the closed-dep resolution below tolerates an unreadable ref.
 *
 * `--paginate` is required: the REST endpoint returns 30 items/page, and a
 * silently-truncated blocker list is the same dangerous under-reporting. With
 * `--paginate` the `--jq` filter runs per page and its outputs are concatenated,
 * so it must emit one raw ref per line (no array wrapper). `select(.repository)`
 * drops any entry with a null repository (a blocker in a repo the token can't
 * see, or a transferred/deleted one) so we never synthesize a bogus `null#N`
 * ref that would strand its dependent as a permanent external blocker.
 *
 * @param {{number:number, repo:string}} node
 * @param {(argv:string[]) => string} runGh
 * @returns {Array<{blocked:string, blockedBy:string}>}
 */
function nativeBlockedByEdges(node, runGh) {
  const selfRef = refOf({ number: node.number, repo: node.repo });
  let out;
  try {
    out = runGh([
      'api', '--paginate',
      `repos/${node.repo}/issues/${node.number}/dependencies/blocked_by`,
      '--jq', '.[] | select(.repository) | "\\(.repository.full_name)#\\(.number)"',
    ]);
  } catch {
    return []; // unconfigured, unavailable, or no access → no edges from this source
  }
  return String(out)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((d) => ({ blocked: selfRef, blockedBy: d }));
}

/**
 * Dedupe edges on the `blocked|blockedBy` composite key, preserving first-seen
 * order. Native and prose edges can name the same pair (a blocker declared both
 * in the dependency graph and in text), and `toTopoNodes` does not dedupe, so a
 * duplicate would otherwise propagate into the core as a repeated dep entry.
 *
 * @param {Array<{blocked:string, blockedBy:string}>} edges
 * @returns {Array<{blocked:string, blockedBy:string}>}
 */
function dedupeEdges(edges) {
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    const key = `${e.blocked}|${e.blockedBy}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

// ---- sub-issue hierarchy walk -------------------------------------------

const defaultWarn = (m) => console.error(m);

/**
 * Walk an epic's sub-issue tree to any depth, breadth-first.
 *
 * GitHub nests epics freely, and only the leaves are units of work: handing an
 * intermediate epic to an implement subagent would hand it a whole sub-tree. So
 * the walk splits the tree in two — `leaves` become the spec's nodes, while
 * `containers` are groupings that never ship but still carry structure, since a
 * dependency naming an epic constrains everything under it (see
 * `rewriteContainerEdges`).
 *
 * Rules, each matching how depth-1 already behaves:
 *  - A CLOSED sub-issue is out of scope, and closing an epic takes its whole
 *    sub-tree with it — the walk does not descend into it. A closed leaf goes
 *    in `closedLeaves` (see `fetchSpec`'s `members`), never in `leaves`.
 *  - A container whose own sub-issue query reports *no sub-issues connection*
 *    (`SubIssuesUnavailable`) is kept as a leaf, with a warning; any other
 *    failure (rate limit, network, auth, a malformed page, or a sub-issue the
 *    token cannot read, which the error names) aborts the fetch.
 *    Its children are unknown, and silently dropping the work is the dangerous
 *    direction; shipping the epic issue itself is recoverable. (A query that
 *    succeeds with no open children is a different case — it is demoted by the
 *    pass below, quietly, because nothing went wrong.)
 *  - A ref already visited is not descended into again, so a malformed cyclic
 *    hierarchy terminates instead of looping forever.
 *  - An open container with no open descendant is demoted back to a leaf: it is
 *    not a grouping of pending work, it *is* the pending work.
 *  - A wave sub-epic (label `ship-dag-wave`) is the exception to both closed and
 *    demoted handling. It only ever groups one wave's issues, so it never ships,
 *    even when empty or fully merged (a session that died before closing it).
 *    And a CLOSED one is still descended into, because an issue left open under
 *    it (a hand-closed wave, or a failed return to the epic) would otherwise
 *    vanish from every later fetch. Each case warns. A wave held back this way
 *    has no pending work, so it lands in `heldWaves` and an edge naming it is
 *    satisfied rather than an external blocker. A wave whose own sub-issue
 *    query reports no sub-issues connection ships nothing this pass: neither
 *    it nor its unknown children.
 *
 * The root epic itself is a container but is *not* read for edges by the caller,
 * and is never demoted: it is the scope boundary, not a participant, exactly as
 * at depth 1. An epic whose every descendant is closed therefore yields no nodes.
 * Any failure listing the root aborts as `epic #N in owner/repo: <message>`,
 * with the original error as `cause`.
 *
 * @param {string} rootRepo  owner/repo of the root epic
 * @param {number|string} rootNumber
 * @param {(argv:string[]) => string} runGh
 * @param {(m:string) => void} [warn]  where warnings go (default `console.error`)
 * @returns {{rootRef:string, leaves:Array<{number:number,repo:string,ref:string}>, closedLeaves:string[],
 *            containerNodes:Array<{number:number,repo:string,ref:string}>,
 *            containers:Map<string,string[]>, parentOf:Map<string,string>, heldWaves:Set<string>}}
 */
function fetchHierarchy(rootRepo, rootNumber, runGh, warn = defaultWarn) {
  const root = { number: Number(rootNumber), repo: rootRepo, ref: refOf({ number: Number(rootNumber), repo: rootRepo }) };
  const containers = new Map(); // container ref -> its direct child refs (open and closed)
  const parentOf = new Map(); // ref -> containing epic's ref, for the ancestor test
  const leaves = [];
  const closedLeaves = []; // refs of closed childless non-wave sub-issues: `members`, never nodes
  const containerNodes = []; // open containers below the root: edges, but never nodes
  const heldWaves = new Set(); // wave sub-epics with nothing open under them: never nodes, edges satisfied
  const visited = new Set([root.ref]);
  const queue = [root];

  while (queue.length) {
    const epicNode = queue.shift();
    let kids;
    try {
      kids = listSubIssues(epicNode, runGh);
    } catch (err) {
      if (epicNode.ref === root.ref) {
        throw new Error(`epic #${epicNode.number} in ${epicNode.repo}: ${err.message}`, { cause: err });
      }
      if (!(err instanceof SubIssuesUnavailable)) throw err;
      if (epicNode.wave) {
        warn(`warning: wave sub-epic ${epicNode.ref} reports sub-issues but none could be read `
          + `(${err.message}); shipping nothing under it this pass`);
        continue;
      }
      warn(`warning: ${epicNode.ref} reports sub-issues but none could be read `
        + `(${err.message}); treating it as a single issue`);
      leaves.push(epicNode);
      continue;
    }
    const recs = kids.map((k) => {
      const kidRepo = subIssueRepo(k, epicNode.repo);
      return { number: k.number, repo: kidRepo, ref: refOf({ number: k.number, repo: kidRepo }), wave: hasWaveLabel(k),
        hasKids: hasSubIssues(k), closed: k.state === 'CLOSED' };
    });
    for (const r of recs) if (r.closed && !r.wave && !r.hasKids) closedLeaves.push(r.ref);
    if (epicNode.closedWave && recs.every((r) => r.closed)) continue;
    if (epicNode.ref !== root.ref) containerNodes.push(epicNode);
    const childRefs = [];
    for (const r of recs) {
      const kid = { number: r.number, repo: r.repo, ref: r.ref };
      if (r.wave) kid.wave = true;
      childRefs.push(kid.ref);
      if (!parentOf.has(kid.ref)) parentOf.set(kid.ref, epicNode.ref);
      if (r.closed) {
        if (!(kid.wave && r.hasKids)) continue;
        kid.closedWave = true;
      } else if (!r.hasKids) {
        if (kid.wave) { // an empty grouping: the pass below holds it back
          containerNodes.push(kid);
          containers.set(kid.ref, []);
        } else {
          leaves.push(kid);
        }
        continue;
      }
      if (visited.has(kid.ref)) {
        warn(`warning: sub-issue hierarchy revisits ${kid.ref}; not descending again`);
        continue;
      }
      visited.add(kid.ref);
      queue.push(kid);
    }
    containers.set(epicNode.ref, childRefs);
  }

  // A container with no open descendant is not a grouping of pending work — it
  // *is* the pending work. GitHub leaves such an epic open (its own body holds
  // the remainder, or it just hasn't been closed out), and expanding it into an
  // empty set would silently delete a shippable issue from the DAG. So demote it
  // back to a leaf. Bottom-up, so an epic whose only open descendant is itself a
  // demoted epic still counts as a grouping and stays one. `containerNodes` is
  // in breadth-first order, hence parents before children, hence this reverse
  // walk visits every child before its parent.
  const openInTree = new Set(leaves.map((l) => l.ref));
  for (let i = containerNodes.length - 1; i >= 0; i -= 1) {
    const c = containerNodes[i];
    if (!(containers.get(c.ref) || []).some((r) => openInTree.has(r))) {
      containers.delete(c.ref); // now a leaf: `leavesUnder` resolves it to itself
      containerNodes.splice(i, 1);
      if (c.wave) { // never work, and not a live descendant of its parent either
        heldWaves.add(c.ref);
        if (!c.closedWave) warn(`warning: ${c.ref} is a wave sub-epic left open with nothing open under it; not shipping it`);
        continue;
      }
      leaves.push(c);
    }
    openInTree.add(c.ref); // either way it is open, so its parent has a live descendant
  }
  for (const c of containerNodes.filter((n) => n.closedWave)) {
    warn(`warning: ${c.ref} is a closed wave sub-epic with open sub-issues `
      + `(${leavesUnder(c.ref, containers).join(', ')}); shipping them anyway — return them to the epic or reopen the wave`);
  }
  return { rootRef: root.ref, leaves, closedLeaves, containerNodes, containers, parentOf, heldWaves };
}

/** A hierarchy with no containment — the `--label` path, where the rewrites below are no-ops. */
function flatHierarchy() {
  return { rootRef: null, leaves: [], closedLeaves: [], containerNodes: [], containers: new Map(), parentOf: new Map(), heldWaves: new Set() };
}

// ---- container-edge rewriting -------------------------------------------

/**
 * Every shippable ref under `ref`: itself when it is a leaf, otherwise its
 * descendants. A container with no resolvable descendants falls back to itself
 * rather than to nothing, so an edge to it is never silently discarded (step 3
 * then classifies it as done or external, as for any out-of-set ref).
 *
 * `seen` guards a hierarchy that revisits a ref. GitHub sub-issues are
 * single-parent, so this only fires on a malformed tree.
 */
function leavesUnder(ref, containers, seen = new Set()) {
  const kids = containers.get(ref);
  if (!kids || seen.has(ref)) return [ref];
  seen.add(ref);
  const out = [];
  for (const k of kids) out.push(...leavesUnder(k, containers, seen));
  return out.length ? out : [ref];
}

/** Whether `ancestorRef` contains `ref`, at any depth. */
function isAncestor(ancestorRef, ref, parentOf) {
  const seen = new Set();
  let cur = parentOf.get(ref);
  while (cur && !seen.has(cur)) {
    if (cur === ancestorRef) return true;
    seen.add(cur);
    cur = parentOf.get(cur);
  }
  return false;
}

/**
 * Translate edges that name a container epic into edges between the issues that
 * actually ship. Two things happen, and both are required once the fetch
 * descends: an intermediate epic is no longer a node, so an edge left pointing
 * at one could never be satisfied (an epic stays open until its last child
 * closes) and would strand its dependent as permanently blocked.
 *
 *  - **Containment artifacts are dropped.** An edge between an issue and one of
 *    its own ancestor epics says "this is part of that", not "this waits for
 *    that" — GitHub's dependency graph surfaces containment that way. This
 *    generalizes the depth-1 epic-self rule to the whole ancestor chain, in both
 *    directions: an epic is by definition blocked by its own children, so
 *    pushing that edge down would make a child block itself. This is not
 *    hypothetical — GitHub really does list an epic as `blocked_by` each of its
 *    own sub-issues, so without this rule an intermediate epic's dependency list
 *    would expand into mutual sibling edges and stall the whole tree on a
 *    fabricated cycle.
 *  - **A self-edge is passed through untouched.** It carries no ordering to
 *    translate; it is corrupt input, and the core reports it as a cycle.
 *  - **Everything else is expanded.** "X is blocked by epic E" becomes "X is
 *    blocked by every leaf of E", and "epic E is blocked by Y" pushes Y onto
 *    every leaf of E. Both endpoints expand, so an epic-to-epic edge becomes the
 *    cross product — faithful, and bounded by real epic sizes. A self-pair that
 *    the *expansion* invents is dropped; a node cannot block itself.
 *
 * A no-op when there is no hierarchy (the `--label` path). Note that on the
 * `--epic` path the root is always registered in `containers`, so that early-out
 * never fires there even for a flat, depth-1 epic.
 *
 * @param {Array<{blocked:string, blockedBy:string}>} edges
 * @param {{containers:Map<string,string[]>, parentOf:Map<string,string>}} hierarchy
 * @returns {Array<{blocked:string, blockedBy:string}>}
 */
function rewriteContainerEdges(edges, { containers, parentOf }) {
  if (!containers.size) return edges;
  const out = [];
  for (const e of edges) {
    // A self-edge carries no ordering to translate — it is corrupt input, and
    // the core's job is to report it as a cycle. Pass it through untouched so
    // that signal survives; expanding it would either erase it (the self-pair
    // guard below) or, on a container, manufacture a cycle across every leaf.
    if (e.blocked === e.blockedBy) { out.push(e); continue; }
    if (isAncestor(e.blockedBy, e.blocked, parentOf)) continue;
    if (isAncestor(e.blocked, e.blockedBy, parentOf)) continue;
    for (const blocked of leavesUnder(e.blocked, containers)) {
      for (const blockedBy of leavesUnder(e.blockedBy, containers)) {
        if (blocked !== blockedBy) out.push({ blocked, blockedBy });
      }
    }
  }
  return out;
}

/**
 * Build a spec by querying GitHub. `runGh(argv) -> string` is injectable so the
 * fetch logic (edge parsing, closed-dependency → done resolution) is testable
 * without hitting the network.
 *
 * Refs are composite throughout: each node carries its own `repo` (a cross-repo
 * sub-issue keeps its home repo, not the epic's), body edges are qualified per
 * citing issue, and a closed/merged dependency is resolved against *its own*
 * repo before being folded into `done`. `repo` (the epic/label repo) is the
 * default for anything left bare.
 *
 * The `--epic` path descends the sub-issue tree to any depth: a sub-issue that
 * is itself an epic is replaced by the issues underneath it, and its own
 * dependencies are pushed down onto them. `--label` selects a flat set and is
 * unaffected. `warn` (default `console.error`) receives the walk's warnings.
 *
 * With `members: true` (the CLI's `--members`), the spec also carries
 * `members`: every leaf in scope, closed ones included — the open nodes plus the
 * closed childless sub-issues the walk saw (epic) or the label's closed issues
 * (label, one more listing). A closed sub-epic is not descended into, so its
 * children are not members. A wave sub-epic is the exception: it is never a
 * member itself, but its children are, open or closed, even when the wave and
 * all its children are closed; an empty one contributes nothing. Planning
 * ignores the field; it exists so the status board can count finished work,
 * which `nodes` and `done` alone cannot.
 */
export function fetchSpec(repo, { epic, label, members = false, warn = defaultWarn }, runGh = realRunGh) {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`--repo must be owner/repo, got: ${repo}`);

  // 1. Discover the open node set as {number, repo} pairs (repo may differ from
  //    the epic's for a cross-repo sub-issue). The epic path walks the whole
  //    sub-issue tree; intermediate epics come back separately, as containers.
  let openNodes = [];
  let closedRefs = [];
  let hierarchy = flatHierarchy();
  if (label) {
    openNodes = listLabel(repo, label, 'open', runGh, warn).map((i) => ({ number: i.number, repo }));
    if (members) closedRefs = listLabel(repo, label, 'closed', runGh, warn).map((i) => refOf({ number: i.number, repo }));
  } else if (epic) {
    hierarchy = fetchHierarchy(repo, epic, runGh, warn);
    openNodes = hierarchy.leaves.map((l) => ({ number: l.number, repo: l.repo }));
    closedRefs = hierarchy.closedLeaves;
  } else {
    throw new Error('fetch needs --epic N or --label L');
  }

  // 2. Read each issue's body → metadata + dependency edges. Refs are keyed on
  //    the issue's own repo. Containers are read for their edges but never
  //    become nodes: they are groupings, and their constraints are pushed onto
  //    the leaves that ship in their place (step 2b). The root epic is skipped
  //    entirely — it is the scope boundary, not a participant.
  const openRefs = new Set(openNodes.map((o) => refOf({ number: o.number, repo: o.repo })));
  const containerRefs = new Set(hierarchy.containerNodes.map((c) => c.ref));
  const nodes = [];
  const edges = [];
  for (const o of [...openNodes, ...hierarchy.containerNodes]) {
    const iss = JSON.parse(runGh(['issue', 'view', String(o.number), '--repo', o.repo,
      '--json', 'number,title,labels,body,state']));
    const body = iss.body || '';
    const ref = refOf({ number: iss.number, repo: o.repo });
    if (!containerRefs.has(ref)) {
      const refs = [...body.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
      nodes.push({
        number: iss.number,
        repo: o.repo,
        ref,
        title: iss.title,
        labels: (iss.labels || []).map((l) => l.name),
        bodyLen: body.length,
        refCount: new Set(refs).size,
      });
    }
    edges.push(...bodyEdges({ number: iss.number, repo: o.repo }, body));
    edges.push(...nativeBlockedByEdges(o, runGh));
  }

  // 2b. Translate edges that name a containing or contained epic — dropping the
  // ones that only express containment, expanding the rest onto the leaves that
  // actually ship. On the label path (no hierarchy) this is a no-op.
  //
  // Then dedupe: native and prose can name the same pair, and the expansion can
  // produce the same pair twice. Dedupe must come before the DAG ever sees the
  // edges (`toTopoNodes` does not dedupe). Doing it before step 3 also means the
  // closed-dep→done resolution classifies each blocker for free: open in-set →
  // a wave edge, closed → done, open out-of-set/unreadable → external.
  const uniqueEdges = dedupeEdges(rewriteContainerEdges(edges, hierarchy));

  // 3. Resolve dependency refs that aren't open nodes: a closed/merged one is
  //    DONE (satisfied), so it must not be mistaken for an unshippable external
  //    blocker. Each dep is viewed in *its own* repo (parsed from the ref),
  //    falling back to the epic/label repo for a bare ref.
  const done = [];
  const depCandidates = new Set(uniqueEdges.map((e) => e.blockedBy).filter((d) => !openRefs.has(d)));
  for (const depRef of depCandidates) {
    if (hierarchy.heldWaves.has(depRef)) { done.push(depRef); continue; } // a wave sub-epic with nothing open under it
    const depRepo = repoOfRef(depRef) || repo;
    const depNum = depRef.slice(depRef.indexOf('#') + 1);
    let state;
    try {
      state = JSON.parse(runGh(['issue', 'view', depNum, '--repo', depRepo, '--json', 'state'])).state;
    } catch {
      continue; // unreadable ref (deleted, no access) → leave as a genuine external blocker
    }
    if (state === 'CLOSED') done.push(depRef);
  }

  const spec = { repo, nodes, edges: uniqueEdges, done };
  if (members) spec.members = [...new Set([...nodes.map((n) => n.ref), ...closedRefs])];
  return spec;
}

// What a capped listing loses: open issues are the DAG's nodes, closed ones only
// the status board's count of finished work.
const CAP_CONSEQUENCE = { open: 'the DAG may be truncated', closed: "the status board's members may be undercounted" };

/** One state of a label's issues, warning rather than truncating silently at the list cap. */
function listLabel(repo, label, state, runGh, warn) {
  const list = JSON.parse(runGh(['issue', 'list', '--repo', repo, '--label', label,
    '--state', state, '--limit', String(LIST_LIMIT), '--json', 'number']));
  if (list.length >= LIST_LIMIT) {
    warn(`warning: ${state} issue list hit the ${LIST_LIMIT} cap; ${CAP_CONSEQUENCE[state]}`);
  }
  return list;
}

const FETCH_VALUE_FLAGS = ['--repo', '--epic', '--label'];

/**
 * `fetch`'s flags: `--repo`, `--epic N` or `--label L`, and `--members` to list closed leaves too.
 * Throws on an unknown argument (so a typo such as `--member` is an error, not a silently
 * dropped flag) and on a value flag whose value is missing or is itself a `--flag`.
 */
export function parseFetchArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--members') opts.members = true;
    else if (FETCH_VALUE_FLAGS.includes(flag)) opts[flag.slice(2)] = stringOption([flag, argv[++i]], flag);
    else throw new Error(`unknown argument: ${flag}`);
  }
  return opts;
}

// ---- CLI ----------------------------------------------------------------

// A ref is display-ready as-is; a bare number gets a leading `#`.
const fmtRef = (r) => (String(r).includes('#') ? String(r) : `#${r}`);

function renderTable({ waves, blocked, cyclic }) {
  const lines = [];
  waves.forEach((w, i) => lines.push(`  wave ${i + 1}: ${w.map(fmtRef).join(', ')}`));
  for (const b of blocked) {
    lines.push(`  blocked (${b.reason}): ${fmtRef(b.ref)} ← missing ${b.missing.map(fmtRef).join(', ')}`);
  }
  if (cyclic.length) lines.push(`  CYCLE (unresolvable): ${cyclic.map(fmtRef).join(', ')}`);
  return lines.join('\n');
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'plan') {
    const src = rest[0];
    if (!src) { process.stderr.write('usage: plan <spec.json|->\n'); process.exit(2); }
    const raw = src === '-' ? readFileSync(0, 'utf8') : readFileSync(src, 'utf8');
    const result = planWaves(JSON.parse(raw));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.stderr.write(renderTable(result) + '\n');
    return;
  }
  if (cmd === 'fetch') {
    const usage = 'usage: fetch --repo owner/repo (--epic N | --label L) [--members]\n';
    let opts;
    try {
      opts = parseFetchArgs(rest);
    } catch (err) {
      process.stderr.write(`plan-waves: ${err.message}\n${usage}`);
      process.exit(2);
    }
    if (!opts.repo || (!opts.epic && !opts.label)) {
      process.stderr.write(usage);
      process.exit(2);
    }
    process.stdout.write(JSON.stringify(fetchSpec(opts.repo, opts), null, 2) + '\n');
    return;
  }
  process.stderr.write('usage: plan-waves.mjs <plan|fetch> ...\n');
  process.exit(2);
}

// Only run the CLI when invoked directly, not when imported by the test.
if (isMain(import.meta.url)) main(process.argv.slice(2));
