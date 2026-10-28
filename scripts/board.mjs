#!/usr/bin/env node
// board.mjs — the status board CLI. `init` writes the run's board.json; `render` builds board.html from the graph
// spec (`dag.json`, never fetched here), one batched GraphQL read of the tickets' GitHub state, and the files the
// engine already leaves in the run family; `refresh` is `render` after re-fetching the graph spec, in one command. The board's four files live in the family's base dir (`runBaseDir`).
// board.json's optional `predecessors: ["owner/repo#N", ...]` names epics whose work came before this run: render reads their
// leaf sub-issues (recursively, paged) in extra batched queries and shows the closed ones as "Shipped before this run".
// A ref GraphQL has no issue for is read once through REST, which follows a transfer: a transferred issue (or predecessor
// epic) is shown under its old ref, linked to its new home, with a warning; a ref REST cannot find either fails the render.
// `refresh` reads board.json's `issueSet` (`{epic: "owner/repo#N"}` or `{repo, label}`), fetches the spec with
// plan-waves.mjs's `fetchSpec` in-process (the equivalent of `plan-waves.mjs fetch --repo R --epic N --members`, or `--label L
// --members`; an epic's cross-repo sub-issues come back unioned by the walk), writes it to `<runBaseDir>/spec-board.json`
// (atomically, so concurrent refreshes are safe) and renders from it. If the fetch fails the render is skipped and the old
// board.html stays. An `issueSet` of `{}` (an explicit set) has nothing to fetch: refresh warns and renders from dag.json,
// and exits 1 when there is no dag.json either (pass `--spec` to `render`, or `init` with --epic/--label).
// Cost of one refresh: about L+2 GraphQL queries and L REST calls for L open leaves, plus ceil(T/40) GraphQL queries to render T tickets
// (the fetch is a `gh issue view` and a `dependencies/blocked_by` read per leaf, one sub-issues query per epic and one list per label
// state; each sub-epic or out-of-set blocker adds one more; the render adds closure and predecessor rounds). The closure reads open
// blockers of open tickets to a fixed point, one round (ceil(width/40) queries) per level of outside blockers, under a
// safety cap of `CLOSURE_CAP` rounds that warns when hit.
// Exit codes: 0 = done; 1 = failed (stderr says why; the old board.html is untouched); 64 = usage.
//
// Usage: board.mjs init   (--state-dir <dir> | --run-id <id>) [--title T] [--epic owner/repo#N | --label L --repo owner/repo]
//                         [--block-on a,b] [--out path] [--abbreviations <json|@file|->] [--predecessors a,b]
//        board.mjs render [--state-dir <dir> | --run-id <id>] [--spec path] [--board-config path] [--out path]
//        board.mjs refresh [--state-dir <dir> | --run-id <id>] [--board-config path] [--out path]
// (render and refresh fall back to $SHIP_DAG_RUN_ID when neither --state-dir nor --run-id is given; init needs one of them.)

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSpec as planWavesFetchSpec } from './plan-waves.mjs';
import { renderBoard } from './board/render.mjs';
import { buildGraph, classify, closedKind, makeRepoLabel, makeShortRef, milestones, projectWaves, shippedBefore } from './board/model.mjs';
import { fetchPredecessors } from './board/predecessors.mjs';
import { readBoard, readJson, readNotes, readRetros, resolveRun, runBaseDir, runWaves } from './board/run.mjs';
import { deriveStage, readFamily } from './board/stage.mjs';
import { remoteSource } from './board/remote.mjs';
import { stringOption } from './lib/cli-args.mjs';
import { ghCli, ghErrorBody, ghFailure, ghNotFound, realRunGh, withBackoff } from './lib/gh.mjs';
import { isMain } from './lib/is-main.mjs';
import { writeAtomic } from './lib/write-atomic.mjs';
import { readArg } from './lib/read-arg.mjs';
import { REPO_RE, formatRef, parseRef, refKey } from './lib/ref.mjs';
import { parseBlockOn } from './review-gate.mjs';
import { runFamilyStateDirs } from './lib/wave-reports.mjs';
import { newestEntries } from './lib/wave-sidecar.mjs';
import { sameRun } from './lib/run-id.mjs';
import { telemetryPath } from './telemetry.mjs';

const EX_USAGE = 64;
const BATCH = 40; // refs per GraphQL query
/** The closure's safety cap: at most this many lookup rounds, round 0 (the run's own refs) included, so a chain of up to 99 outside blockers is read whole. */
export const CLOSURE_CAP = 100;
/** How many sub-issue parents up the lookup reads, to name an outside ticket's top epic (issue #522). */
const PARENT_DEPTH = 4;
const parentField = (depth) => (depth ? `parent{number title url repository{nameWithOwner} ${parentField(depth - 1)}}` : '');
const FIELDS = 'number title url state stateReason createdAt closedAt labels(first:100){nodes{name}} closedByPullRequestsReferences(first:20,includeClosedPrs:true){nodes{number url state}} '
  + `blockedBy(first:50){nodes{number state stateReason closedAt repository{nameWithOwner}}} ${parentField(PARENT_DEPTH)}`;
const SUB_ISSUES = ['-H', 'GraphQL-Features: sub_issues']; // `parent` and `subIssues` are sub-issue fields

const SCRIPT = fileURLToPath(import.meta.url);

/** A bad argument: `main` exits 64 for it. */
class UsageError extends Error {}
const usage = (fn) => { try { return fn(); } catch (err) { throw new UsageError(err.message); } };
const shellWord = (w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replaceAll("'", "'\\''")}'`);

const asRef = (ref) => parseRef(ref) ?? (() => { throw new Error(`not an owner/repo#N ref: ${JSON.stringify(ref)}`); })();

/** One GraphQL answer. gh exits 1 when any alias is NOT_FOUND; that body's `data` still answers every other alias. */
async function answer(query, { runGh, sleep }, extra = []) {
  try { return JSON.parse(await withBackoff(() => runGh(['api', 'graphql', ...extra, '-f', `query=${query}`]), { repo: 'GitHub', sleep })); } catch (err) {
    if (ghNotFound(err) && ghErrorBody(err).data) return ghErrorBody(err);
    throw err;
  }
}

/**
 * Where `ref`'s issue lives now, for a ref GraphQL has no issue for: GraphQL's `repository{issue}` does not follow a
 * transfer, REST's `repos/<repo>/issues/<n>` does. The new ref, or null when REST has no issue there either (a 404,
 * a 410 for a deleted one, a 403 the token cannot read past) or answers with a pull request or the same ref.
 */
async function transferredTo(ref, { runGh, sleep }) {
  const { repo, number } = asRef(ref);
  let issue;
  try { issue = JSON.parse(await withBackoff(() => runGh(['api', `repos/${repo}/issues/${number}`]), { repo, sleep })); } catch (err) {
    const failure = ghFailure(err);
    if ([403, 404, 410].includes(failure.status) && !failure.rateLimited) return null;
    throw err;
  }
  const home = /\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(issue?.html_url ?? '');
  const to = home && formatRef(home[1], Number(home[2]));
  return to && refKey(to) !== refKey(ref) ? to : null;
}

/** `transferredTo`, asked once per ref and in parallel by its callers, with one warning per transfer found. */
function transfers(deps, warn) {
  const asked = new Map();
  return (ref) => {
    if (!asked.has(ref)) {
      asked.set(ref, transferredTo(ref, deps).then((to) => {
        if (to) warn(`${ref} was transferred to ${to}; shown under ${ref}`);
        return to;
      }));
    }
    return asked.get(ref);
  };
}

/**
 * Look `refs` up, `BATCH` to a query. Returns `[ref, issue]` pairs, keyed on the refs asked for. A ref whose issue
 * was transferred is read at its new home and answered under the old ref, its issue carrying `transferredTo` (the new
 * ref); `moved` is `transfers`'. Refs GitHub has no issue for at all throw, named together.
 */
async function lookup(refs, deps, moved) {
  const found = [];
  const missing = [];
  for (let i = 0; i < refs.length; i += BATCH) {
    const batch = refs.slice(i, i + BATCH);
    const query = `query{${batch.map((ref, j) => {
      const { repo, number } = asRef(ref);
      const [owner, name] = repo.split('/');
      return `r${j}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){issue(number:${number}){${FIELDS}}}`;
    }).join(' ')}}`;
    const { data } = await answer(query, deps, SUB_ISSUES);
    batch.forEach((ref, j) => (data?.[`r${j}`]?.issue ? found.push([ref, data[`r${j}`].issue]) : missing.push(ref)));
  }
  const homes = await Promise.all(missing.map(async (ref) => [ref, await moved(ref)]));
  const gone = homes.filter(([, to]) => !to).map(([ref]) => ref);
  if (gone.length) throw new Error(`${gone.join(', ')}: GitHub has no such issue`);
  if (homes.length) {
    const there = new Map((await lookup(homes.map(([, to]) => to), deps, moved)).map(([to, issue]) => [refKey(to), issue]));
    for (const [ref, to] of homes) found.push([ref, { ...there.get(refKey(to)), transferredTo: to }]);
  }
  return found;
}

/**
 * The open issues outside the run that `from` (the run's open tickets) wait on, directly or through each other: the
 * ancestors over `edges` that are open, read by the closure (`info`) and not run tickets. The walk goes on through each
 * one it keeps, and stops at a closed or unread blocker. Left out are the run's own epic, which blocks nothing, and the
 * open blockers of a closed member, whose edges the graph drops.
 *
 * @returns {string[]}
 */
function outsideAncestors(from, edges, run, info, state) {
  const blockers = new Map();
  for (const { blocked, blockedBy } of edges) blockers.set(blocked, [...(blockers.get(blocked) ?? []), blockedBy]);
  const found = new Set();
  const stack = [...from];
  while (stack.length) {
    for (const b of blockers.get(stack.pop()) ?? []) {
      if (found.has(b) || run.has(b) || !info.has(b) || state.get(b) !== 'OPEN') continue;
      found.add(b);
      stack.push(b);
    }
  }
  return [...found];
}

/** An issue's closing PRs, their states lower-cased. */
const prsOf = (issue) => issue.closedByPullRequestsReferences.nodes.map((p) => ({ ...p, state: p.state.toLowerCase() }));

/** The top of an issue's sub-issue parents, as far as the lookup read them, as `{ref, title, url}`; null for an issue with none. */
function topParent(issue) {
  let top = null;
  for (let p = issue.parent; p; p = p.parent) top = p;
  return top && { ref: formatRef(top.repository.nameWithOwner, top.number), title: top.title, url: top.url };
}

/** Whether a ticket closed as shipped (not without shipping) at or after `startedAt` (epoch ms): a null `closedAt` never is. */
const shippedSince = ({ state, stateReason, closedAt }, startedAt) => state === 'CLOSED' && closedKind(stateReason) === 'shipped' && closedAt != null && Date.parse(closedAt) >= startedAt;

/** Everything `render` reads, the tickets' GitHub state included, turned into `renderBoard`'s input. */
async function gather({ run, dir, dirs, flag, rebuild, deps, warn }) {
  const waves = runWaves({ runId: run.runId, runDir: dir }, { warn, dirs });
  if (!waves.length) throw new Error(`no run ${run.runId} under ${dir}`);
  const board = readBoard(dir, { path: flag('--board-config') });
  if (!board) throw new Error(`${join(dir, 'board.json')} absent: run \`board.mjs init\` first`);
  const specPath = flag('--spec') ?? join(dir, 'dag.json');
  const spec = readJson(specPath);
  if (!spec) throw new Error(`${specPath} absent: write the step-1 graph spec there, or pass --spec`);
  if (!Array.isArray(spec.nodes)) throw new Error(`${specPath} has no nodes array: it is not a graph spec (emit-config's spec.json is not one)`);
  const notes = readNotes(dir) ?? {};
  const refOf = (n) => (typeof n === 'string' ? n : n.ref);
  const nodes = spec.nodes.map(refOf);
  const retro = readRetros(run.runId, { path: telemetryPath(deps.env) }).flatMap((r) => r.filed ?? []);
  const epic = board.issueSet?.epic;
  if (board.predecessors !== undefined && !Array.isArray(board.predecessors)) throw new Error('board.json predecessors must be an array of owner/repo#N refs');
  const predecessors = [...new Set(board.predecessors ?? [])];
  predecessors.forEach((ref) => asRef(ref));
  // The walk needs nothing the lookups below return, so it runs beside them; a no-op catch keeps an early failure of
  // theirs from leaving its rejection unhandled, and the await below still throws it.
  const moved = transfers(deps, warn);
  const walk = fetchPredecessors(predecessors, (q) => answer(q, deps, SUB_ISSUES), { transferredTo: moved });
  walk.catch(() => {});
  // The run's tickets, as the spec and the run's files name them: the members, then what the waves, retros and notes add.
  // They are the roots of the required set (issue #522).
  const memberRefs = spec.members ?? [...nodes, ...(spec.done ?? [])];
  const added = [...waves.flatMap((w) => w.refs), ...retro, ...(notes.extraRefs ?? [])];
  const roots = new Set([...memberRefs, ...added]);
  const wanted = [...new Set([...roots, ...nodes, ...(spec.edges ?? []).flatMap((e) => [e.blocked, e.blockedBy]), ...(epic ? [epic] : [])])];
  const startedAt = Date.parse(board.startedAt);
  if (Number.isNaN(startedAt)) warn(`board.json startedAt ${JSON.stringify(board.startedAt)} is not a date: closed outside blockers are not counted`);
  const info = new Map(); // ref → the issue GitHub returned
  const state = new Map(); // ref → OPEN | CLOSED, also for a blocker no one has looked up
  const native = []; // GitHub's own blockedBy edges
  const known = new Map(); // a transferred issue's new ref → the ref the run knows it by
  const canon = (ref) => known.get(refKey(ref)) ?? ref; // the one name the board uses for an issue
  // The closure reads an open ticket's open blockers (only those can be drawn) and its closed ones that shipped since the
  // run started, and a shipped run ticket's closed ones; nothing behind a closed outside ticket, a dropped ticket or the
  // epic, which blocks nothing in the run, so a closed outside ticket is a leaf.
  let todo = wanted;
  for (let round = 0; todo.length; round += 1) {
    if (round >= CLOSURE_CAP) {
      // Past the cap the open blockers are left unread, but the closed leaves due this round are still read: they queue
      // nothing, so the loop ends.
      const open = todo.filter((ref) => state.get(ref) === 'OPEN').length;
      if (open) warn(`closure hit its safety cap of ${CLOSURE_CAP} rounds; ${open} open blocker${open === 1 ? '' : 's'} unread`);
      todo = todo.filter((ref) => state.get(ref) !== 'OPEN');
      if (!todo.length) break;
    }
    const found = await lookup(todo, deps, moved);
    for (const [ref, issue] of found) {
      info.set(ref, issue);
      state.set(ref, issue.state);
      if (issue.transferredTo) known.set(refKey(issue.transferredTo), ref);
    }
    const next = new Set(); // the next round's refs: blockers this round queued that no round has read
    for (const [ref, issue] of found) {
      const open = issue.state === 'OPEN';
      const follow = open ? ref !== epic : roots.has(ref) && closedKind(issue.stateReason) === 'shipped';
      for (const b of issue.blockedBy.nodes) {
        const at = formatRef(b.repository.nameWithOwner, b.number);
        const blocker = canon(at); // GitHub names a moved blocker by its new ref
        native.push({ blocked: ref, blockedBy: blocker });
        if (!state.has(blocker)) state.set(blocker, b.state);
        if (follow && !info.has(blocker) && (b.state === 'OPEN' ? open : shippedSince(b, startedAt))) next.add(blocker);
      }
    }
    todo = [...next];
  }

  // The spec may name a transferred issue by its new ref while the waves name it by its old one: the board uses the old.
  const members = memberRefs.map(canon);
  const edges = (spec.edges ?? []).map((e) => ({ blocked: canon(e.blocked), blockedBy: canon(e.blockedBy) }));
  const dropped = (ref) => board.issueSet?.label && info.get(ref).state === 'CLOSED' && Date.parse(info.get(ref).closedAt) < startedAt;
  const refs = [...new Set([...members.filter((r) => !dropped(r)), ...added].map(canon))];
  const allEdges = [...edges, ...native];
  const family = readFamily(dir, { runId: run.runId, warn, dirs });
  const latest = new Map(waves.flatMap((w) => w.refs.map((ref) => [ref, w]))); // oldest first, so the newest wave wins
  const tickets = refs.map((ref) => {
    const issue = info.get(ref);
    const prs = prsOf(issue);
    const open = prs.find((p) => p.state === 'open');
    const item = notes.items?.[ref] ?? {};
    const status = classify({
      state: issue.state, stateReason: issue.stateReason, hasOpenPr: !!open, owned: item.owner === 'you',
      openBlockers: allEdges.filter((e) => e.blocked === ref && state.get(e.blockedBy) === 'OPEN').length,
    });
    const wave = issue.state === 'OPEN' && latest.get(ref);
    // A remote host's ticket reads the copy host-run keeps of its engine files; with none yet, or a stale one from an
    // unreachable host, it reads the wave dir, where only the run's own review files can say anything.
    const remote = wave && remoteSource(wave, family.dirs, ref);
    const engineDir = remote?.dir && !remote.unreachable ? remote.dir : wave?.dir;
    const derived = wave && deriveStage({ dir: engineDir, ref, waveTs: wave.mtimeMs, family, blockOn: board.blockOn, prOpen: !!open, openPr: open?.number });
    const labels = issue.labels?.nodes.map((l) => l.name) ?? []; // a hitl-gate label makes a milestone (issue #518)
    return { ref, title: issue.title, url: issue.url, labels, status, stage: derived || item.stage, note: item.note, prs, createdAt: issue.createdAt, closedAt: issue.closedAt, shippedWave: latest.get(ref)?.id, ...(remote && { remote }) };
  });

  const openRefs = tickets.filter((t) => t.status !== 'shipped' && t.status !== 'dropped').map((t) => t.ref);
  const closedRefs = [...state].filter(([, s]) => s === 'CLOSED').map(([ref]) => ref);
  // The open issues outside the run that open run tickets wait on, as far as the closure read them, are drawn as nodes of
  // their own; one with no orderable run ticket behind it (it sits in a cycle, or its dependents wait on an unread blocker
  // too) would be an orphan, so the graph is rebuilt without it. `descendants` is transitive, so one pass is enough.
  const runSet = new Set(refs);
  let outside = outsideAncestors(openRefs, allEdges, runSet, info, state);
  let graph = buildGraph(openRefs, allEdges, closedRefs, { outside });
  const placed = outside.filter((r) => [...(graph.descendants.get(r) ?? [])].some((d) => !graph.outside.has(d)));
  if (placed.length < outside.length) {
    outside = placed;
    graph = buildGraph(openRefs, allEdges, closedRefs, { outside });
  }
  // A closed outside ticket that shipped since the run started, and that an open run ticket (orderable or not), a drawn
  // outside ticket or a shipped run ticket waits on, is required work already done (issue #522). It is a leaf: only
  // tickets the closure read count.
  const live = new Set([...openRefs, ...outside, ...tickets.filter((t) => t.status === 'shipped').map((t) => t.ref)]);
  const done = [...new Set(allEdges.filter((e) => live.has(e.blocked)).map((e) => e.blockedBy))]
    .filter((ref) => !runSet.has(ref) && info.has(ref) && shippedSince(info.get(ref), startedAt));
  const outsideTickets = [...outside.map((ref) => ({ ref, status: 'outside' })), ...done.map((ref) => ({ ref, status: 'shipped', closedAt: info.get(ref).closedAt }))]
    .map((t) => ({ ...t, title: info.get(t.ref).title, url: info.get(t.ref).url, prs: prsOf(info.get(t.ref)) }));
  // Each outside ticket's owner (issue #522): its top epic, and the other run whose wave sidecar emitted it last, if any.
  const emitted = outsideTickets.length ? newestEntries(dirname(dir), { warn, skip: (d, e) => sameRun(e.runId ?? basename(d), run.runId) }) : new Map();
  for (const t of outsideTickets) {
    const by = emitted.get(refKey(t.ref));
    t.owner = { home: topParent(info.get(t.ref)), run: by ? by.entry.runId ?? basename(by.dir) : null };
  }
  const named = notes.milestones;
  if (named !== undefined && named !== null && (typeof named !== 'object' || Array.isArray(named))) {
    warn('board-notes milestones must be an object of ref to name (or false); it is ignored');
  } else {
    for (const ref of Object.keys(named ?? {}).filter((r) => !tickets.some((t) => t.ref === r))) {
      warn(`board-notes milestones names ${ref}, which is not a ticket of this run`);
    }
  }
  const newest = waves[waves.length - 1];
  const current = { id: newest.id, refs: new Set(newest.refs) };
  // The run's own tickets and the outside ones it counts (issue #522) are left out: any other closed blocker still shipped before.
  const before = shippedBefore(await walk, [...refs, ...done]);
  const repos = [...refs, ...outside, ...done, ...outsideTickets.flatMap((t) => (t.owner.home ? [t.owner.home.ref] : [])), ...before.flatMap((g) => [g.ref, ...g.shipped.map((l) => l.ref)])].map((ref) => asRef(ref).repo);
  const shortRef = makeShortRef(repos, board.abbreviations);
  const scope = epic ? { url: info.get(epic).url, label: shortRef(epic), title: info.get(epic).title }
    : board.issueSet?.label ? { url: `https://github.com/${board.issueSet.repo}/issues?q=label%3A${encodeURIComponent(board.issueSet.label)}`, label: board.issueSet.label, title: board.issueSet.repo } : null;
  const projected = projectWaves(graph, new Map(tickets.map((t) => [t.ref, t.status])), current);
  return {
    title: board.title, runId: board.runId ?? run.runId, scope, now: deps.now().toISOString(), tickets, outsideTickets, graph, current,
    out: flag('--out') ?? board.out ?? join(dir, 'board.html'),
    waves: projected, milestones: milestones({ tickets, graph, waves: projected, notes }), shortRef,
    repoLabel: makeRepoLabel(repos, board.abbreviations), notes, rebuild, before, startedAt: board.startedAt,
  };
}

/** The default `fetchSpec(repo, {epic|label, members, warn})`: plan-waves', driven by `runGhSync`. A replacement may be sync or async. */
const planWavesFetch = (runGhSync) => (repo, opts) => planWavesFetchSpec(repo, opts, runGhSync);

/**
 * `refresh`'s fetch: the run's graph spec for board.json's `issueSet`, written atomically to `<dir>/spec-board.json`.
 * @returns {Promise<string|null>} the spec's path, or null when the issue set is explicit (nothing to fetch)
 * @throws when board.json is absent or the fetch fails; spec-board.json is then left as it was
 */
async function refreshSpec({ dir, flag, fetchSpec, warn }) {
  const board = readBoard(dir, { path: flag('--board-config') });
  if (!board) throw new Error(`${join(dir, 'board.json')} absent: run \`board.mjs init\` first`);
  const { epic, label, repo } = board.issueSet ?? {};
  if (!epic && !label) {
    if (!readJson(join(dir, 'dag.json'))) {
      throw new Error(`board.json names neither an epic nor a label (an explicit issue set) and ${join(dir, 'dag.json')} is absent, so there is no graph to render: write the graph spec there, pass \`--spec\` to \`board.mjs render\`, or re-init with --epic or --label`);
    }
    warn('board.json names neither an epic nor a label: the spec is not re-fetched; rendering from dag.json (or write the graph there first)');
    return null;
  }
  const ref = epic && asRef(epic);
  const spec = epic ? await fetchSpec(ref.repo, { epic: String(ref.number), members: true, warn })
    : await fetchSpec(repo, { label, members: true, warn });
  const path = join(dir, 'spec-board.json');
  writeAtomic(path, `${JSON.stringify(spec, null, 2)}\n`);
  return path;
}

/**
 * Run the CLI. `deps` injects `runGh` (`async (args) => stdout`), `now`, `env`, `log` (a line to stderr) and `sleep`
 * (the rate-limit backoff's wait), so a test touches neither GitHub nor the clock. `refresh` also takes `runGhSync`
 * (`(args) => stdout`, what plan-waves' `fetchSpec` drives) or, to replace the fetch whole, `fetchSpec`.
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, {
  runGh = ghCli, now = () => new Date(), env = process.env, log = (m) => process.stderr.write(`${m}\n`), sleep,
  runGhSync = realRunGh, fetchSpec = planWavesFetch(runGhSync),
} = {}) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'init' && cmd !== 'render' && cmd !== 'refresh') {
    log('usage: board.mjs init|render|refresh (--state-dir <dir> | --run-id <id>) [options]');
    return EX_USAGE;
  }
  const seen = new Set();
  const warn = (m) => { if (!seen.has(m)) { seen.add(m); log(`[board] ${m}`); } };
  const flag = (name) => usage(() => stringOption(rest, name));
  try {
    const run = usage(() => resolveRun({ stateDir: flag('--state-dir'), runId: flag('--run-id'), env, envFallback: cmd !== 'init' }));
    const dirs = runFamilyStateDirs(run.runDir, { runId: run.runId, warn }); // listed once, for every reader
    const dir = runBaseDir(run, { warn, dirs });
    if (cmd === 'init') {
      const [epic, label, repo, abbreviations] = [flag('--epic'), flag('--label'), flag('--repo'), flag('--abbreviations')];
      const predecessors = flag('--predecessors')?.split(',').map((ref) => ref.trim());
      if (epic) usage(() => asRef(epic));
      predecessors?.forEach((ref) => usage(() => asRef(ref)));
      if (label && !REPO_RE.test(repo ?? '')) throw new UsageError('--label needs --repo owner/repo');
      const out = flag('--out');
      const board = {
        runId: run.runId, title: flag('--title') ?? `Run ${run.runId}`, issueSet: epic ? { epic } : label ? { repo, label } : {},
        blockOn: usage(() => parseBlockOn(flag('--block-on'))), startedAt: now().toISOString(), ...(out && { out }),
        ...(abbreviations && { abbreviations: JSON.parse(readArg(abbreviations)) }), ...(predecessors && { predecessors }),
      };
      const path = join(dir, 'board.json');
      mkdirSync(dir, { recursive: true });
      try { writeFileSync(path, `${JSON.stringify(board, null, 2)}\n`, { flag: 'wx' }); } catch (err) { // written once
        throw err.code === 'EEXIST' ? new Error(`board.json already exists at ${path}`) : err;
      }
      warn(`wrote ${path}`);
      return 0;
    }
    // The command this page was built with, naming the run when it came from $SHIP_DAG_RUN_ID.
    const named = rest.includes('--state-dir') || rest.includes('--run-id');
    const rebuild = ['node', SCRIPT, cmd, ...rest, ...(named ? [] : ['--run-id', run.runId])].map(shellWord).join(' ');
    let readFlag = flag;
    if (cmd === 'refresh') {
      if (flag('--spec') !== undefined) throw new UsageError('refresh writes its own spec (spec-board.json): --spec is for render');
      const specPath = await refreshSpec({ dir, flag, fetchSpec, warn });
      if (specPath) readFlag = (name) => (name === '--spec' ? specPath : flag(name));
    }
    const view = await gather({ run, dir, dirs, flag: readFlag, rebuild, deps: { runGh, now, env, sleep }, warn });
    writeAtomic(view.out, renderBoard(view));
    warn(`wrote ${view.out} (${view.tickets.length} tickets)`);
    return 0;
  } catch (err) {
    log(`[board] ${err.message}`);
    return err instanceof UsageError ? EX_USAGE : 1;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
