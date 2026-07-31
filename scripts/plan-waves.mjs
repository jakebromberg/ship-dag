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
// specifics: the gh-fetch wrapper, body-prose edge parsing, spec→core conversion,
// and the human-readable table. Set `CO_HOME` to your claude-orchestrator
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
//     "done":  ["owner/repo#1", "owner/repo#2"]              // already merged/closed
//   }
//   Edge endpoints and `done` entries may be a number, `"#N"`, `"N"`, or a
//   fully-qualified `"owner/repo#N"`; all are normalized to refs before planning.
//
// Usage:
//   node plan-waves.mjs plan <spec.json|->      # partition a spec into waves (stdin with -)
//   node plan-waves.mjs fetch --repo owner/repo (--epic N | --label L)   # build a spec via gh
//   node plan-waves.mjs fetch ... > spec.json && node plan-waves.mjs plan spec.json
//   node plan-waves.mjs fetch ... | node plan-waves.mjs plan -           # or composed
//
// `plan` prints { waves, blocked, cyclic } as JSON (refs) plus a human-readable table.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { isMain } from './lib/is-main.mjs';

const LIST_LIMIT = 1000; // gh issue list cap; we warn if we hit it rather than truncate silently.

// ---- shared topo core (single source of truth for the graph math) --------

const CO_HOME = process.env.CO_HOME || '/Users/me/Developer/claude-orchestrator';
const CORE_ENTRY = resolve(CO_HOME, 'dist/src/index.js');

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
// A line that is nothing but a "Blocked by" / "Depends on" heading — an
// optional markdown `#` prefix, the phrase, and an optional trailing colon —
// e.g. "## Blocked by" or plain "Depends on:". No ref may follow on the same
// line; that's the adjacent-clause form the first pass above already handles.
const DEP_HEADING_RE = /^#{0,6}\s*(?:blocked by|depends on)\s*:?\s*$/i;
// A markdown bullet line: "- " or "* " followed by the rest (the ref plus any
// "— annotation").
const BULLET_RE = /^\s*[-*]\s+(.*)$/;
// An already-resolved annotation on a heading-list bullet ("#877 — RESOLVED,
// merged in #900") — a stale reference to a since-closed blocker, not a live
// edge, so its bullet is skipped rather than emitted.
const RESOLVED_RE = /\bresolved\b/i;

/**
 * Extract dependency edges from an issue body. Handles multi-issue clauses
 * ("Blocked by #12, #13 and #14"), the reverse direction ("Blocks #20"), and
 * cross-repo references ("Blocked by owner/repo#3") — refs adjacent to the
 * phrase, all on one line. Also handles the common heading-plus-bulleted-list
 * layout, where the refs live one per bullet under their own heading line:
 *   ## Blocked by
 *   - WXYC/Backend-Service#877 — Epic C …
 *   - WXYC/Backend-Service#878 — Epic D …
 * A heading's bullets are scanned until a blank line or a non-bullet line
 * (typically the next heading) ends the list; a bullet annotated as already
 * resolved ("— RESOLVED …") is skipped since it no longer names a live
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
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (!line.trim()) break; // blank line ends the list
      const bullet = line.match(BULLET_RE);
      if (!bullet) break; // non-bullet line (e.g. the next heading) ends the list
      if (RESOLVED_RE.test(bullet[1])) continue; // stale bullet — no live edge
      for (const r of bullet[1].matchAll(tokens)) {
        edges.push({ blocked: selfRef, blockedBy: normalizeDep(r[0], cite) });
      }
    }
  }
  return dedupeEdges(edges);
}

// ---- gh wrapper (injectable for tests) ----------------------------------

function realRunGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

/**
 * Native GitHub issue-dependency ("blocked by") edges for one node, in the same
 * `{blocked, blockedBy}` ref shape `bodyEdges` emits. This is a separate feature
 * from body prose — many issues declare a blocker through the dependency graph
 * without ever mentioning it in text, and missing that edge is the dangerous
 * failure direction (a genuinely-blocked issue reported as ready). Tolerates a
 * repo where native dependencies aren't configured, or aren't visible to the
 * token: any failure, or a non-array result, yields no edges rather than
 * aborting the fetch — mirroring how the closed-dep resolution below tolerates
 * an unreadable ref.
 *
 * @param {{number:number, repo:string}} node
 * @param {(argv:string[]) => string} runGh
 * @returns {Array<{blocked:string, blockedBy:string}>}
 */
function nativeBlockedByEdges(node, runGh) {
  const selfRef = refOf({ number: node.number, repo: node.repo });
  let deps;
  try {
    deps = JSON.parse(runGh([
      'api', `repos/${node.repo}/issues/${node.number}/dependencies/blocked_by`,
      '--jq', '[.[] | "\\(.repository.full_name)#\\(.number)"]',
    ]));
  } catch {
    return []; // unconfigured, unavailable, or no access → no edges from this source
  }
  if (!Array.isArray(deps)) return [];
  return deps.map((d) => ({ blocked: selfRef, blockedBy: d }));
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
 */
export function fetchSpec(repo, { epic, label }, runGh = realRunGh) {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`--repo must be owner/repo, got: ${repo}`);

  // 1. Discover the open node set as {number, repo} pairs (repo may differ from
  //    the epic's for a cross-repo sub-issue).
  let openNodes = [];
  if (label) {
    const list = JSON.parse(runGh(['issue', 'list', '--repo', repo, '--label', label,
      '--state', 'open', '--limit', String(LIST_LIMIT), '--json', 'number']));
    if (list.length >= LIST_LIMIT) {
      process.stderr.write(`warning: issue list hit the ${LIST_LIMIT} cap; the DAG may be truncated\n`);
    }
    openNodes = list.map((i) => ({ number: i.number, repo }));
  } else if (epic) {
    // Native sub-issues via GraphQL, paginated so large epics aren't silently
    // truncated. `repository.nameWithOwner` qualifies cross-repo sub-issues.
    let cursor = null;
    const sub = [];
    do {
      const q = 'query($owner:String!,$name:String!,$n:Int!,$cursor:String){repository(owner:$owner,name:$name)'
        + '{issue(number:$n){subIssues(first:100,after:$cursor){nodes{number state repository{nameWithOwner}}'
        + 'pageInfo{hasNextPage endCursor}}}}}';
      const argv = ['api', 'graphql', '-H', 'GraphQL-Features: sub_issues', '-f', `query=${q}`,
        '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `n=${epic}`];
      if (cursor) argv.push('-F', `cursor=${cursor}`);
      const resp = JSON.parse(runGh(argv));
      const issue = resp && resp.data && resp.data.repository && resp.data.repository.issue;
      if (!issue || !issue.subIssues) {
        throw new Error(`epic #${epic} in ${repo}: no sub-issues returned `
          + `(bad number, or the sub-issues feature is unavailable): ${JSON.stringify(resp.errors || resp)}`);
      }
      sub.push(...issue.subIssues.nodes);
      cursor = issue.subIssues.pageInfo.hasNextPage ? issue.subIssues.pageInfo.endCursor : null;
    } while (cursor);
    openNodes = sub
      .filter((s) => s.state !== 'CLOSED')
      .map((s) => ({ number: s.number, repo: (s.repository && s.repository.nameWithOwner) || repo }));
  } else {
    throw new Error('fetch needs --epic N or --label L');
  }

  // 2. Read each node's body → metadata + dependency edges. Refs are keyed on
  //    the node's own repo.
  const openRefs = new Set(openNodes.map((o) => refOf({ number: o.number, repo: o.repo })));
  const nodes = [];
  const edges = [];
  for (const o of openNodes) {
    const iss = JSON.parse(runGh(['issue', 'view', String(o.number), '--repo', o.repo,
      '--json', 'number,title,labels,body,state']));
    const body = iss.body || '';
    const refs = [...body.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
    nodes.push({
      number: iss.number,
      repo: o.repo,
      ref: refOf({ number: iss.number, repo: o.repo }),
      title: iss.title,
      labels: (iss.labels || []).map((l) => l.name),
      bodyLen: body.length,
      refCount: new Set(refs).size,
    });
    edges.push(...bodyEdges({ number: iss.number, repo: o.repo }, body));
    edges.push(...nativeBlockedByEdges(o, runGh));
  }
  // Native and prose can name the same pair; dedupe before the DAG ever sees
  // it (`toTopoNodes` does not dedupe). Doing this before step 3 also means the
  // closed-dep→done resolution classifies each native blocker for free: open
  // in-set → a wave edge, closed → done, open out-of-set/unreadable → external.
  let uniqueEdges = dedupeEdges(edges);

  // 2b. On an --epic fetch, drop any edge whose blockedBy is the epic itself.
  // A native dependency graph can surface "this issue is part of that epic" as
  // a blocked_by edge on the epic's own number; left in, the child would be
  // stranded in `blocked (external)` forever, since an epic stays open until
  // its last child closes — trading the false "everything ready" this change
  // fixes for a false "everything blocked". Narrowly scoped to the one known
  // epic ref (not a full ancestor graph), per the fetched nodes being that
  // epic's own children.
  if (epic) {
    const epicRef = refOf({ number: Number(epic), repo });
    uniqueEdges = uniqueEdges.filter((e) => e.blockedBy !== epicRef);
  }

  // 3. Resolve dependency refs that aren't open nodes: a closed/merged one is
  //    DONE (satisfied), so it must not be mistaken for an unshippable external
  //    blocker. Each dep is viewed in *its own* repo (parsed from the ref),
  //    falling back to the epic/label repo for a bare ref.
  const done = [];
  const depCandidates = new Set(uniqueEdges.map((e) => e.blockedBy).filter((d) => !openRefs.has(d)));
  for (const depRef of depCandidates) {
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

  return { repo, nodes, edges: uniqueEdges, done };
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
    const opts = {};
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '--repo') opts.repo = rest[++i];
      else if (rest[i] === '--epic') opts.epic = rest[++i];
      else if (rest[i] === '--label') opts.label = rest[++i];
    }
    if (!opts.repo || (!opts.epic && !opts.label)) {
      process.stderr.write('usage: fetch --repo owner/repo (--epic N | --label L)\n');
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
