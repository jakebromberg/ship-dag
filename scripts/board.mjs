#!/usr/bin/env node
// board.mjs — the status board CLI. `init` writes the run's board.json; `render` builds board.html from the graph
// spec (`dag.json`, never fetched here), one batched GraphQL read of the tickets' GitHub state, and the files the
// engine already leaves in the run family; `refresh` is `render` after re-fetching the graph spec, in one command. The board's four files live in the family's base dir (`runBaseDir`).
// board.json's optional `predecessors: ["owner/repo#N", ...]` names epics whose work came before this run: render reads their
// leaf sub-issues (recursively, paged) in extra batched queries and shows the closed ones as "Shipped before this run".
// `refresh` reads board.json's `issueSet` (`{epic: "owner/repo#N"}` or `{repo, label}`), fetches the spec with
// plan-waves.mjs's `fetchSpec` in-process (the equivalent of `plan-waves.mjs fetch --repo R --epic N --members`, or `--label L
// --members`; an epic's cross-repo sub-issues come back unioned by the walk), writes it to `<runBaseDir>/spec-board.json`
// (atomically, so concurrent refreshes are safe) and renders from it. If the fetch fails the render is skipped and the old
// board.html stays. An `issueSet` of `{}` (an explicit set) has nothing to fetch: refresh warns and renders from dag.json.
// Cost: the fetch is one `gh` call per issue in scope (a view, plus a dependency read), a few more per epic level; the render is
// one GraphQL query per 40 tickets, plus closure and predecessor rounds. A 20-ticket run is roughly 60 `gh` calls and 1-2 queries.
// Exit codes: 0 = done; 1 = failed (stderr says why; the old board.html is untouched); 64 = usage.
//
// Usage: board.mjs init   (--state-dir <dir> | --run-id <id>) [--title T] [--epic owner/repo#N | --label L --repo owner/repo]
//                         [--block-on a,b] [--out path] [--abbreviations <json|@file|->] [--predecessors a,b]
//        board.mjs render [--state-dir <dir> | --run-id <id>] [--spec path] [--board-config path] [--out path]
//        board.mjs refresh (--state-dir <dir> | --run-id <id>) [--board-config path] [--out path]

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderBoard } from './board/render.mjs';
import { buildGraph, classify, makeRepoLabel, makeShortRef, projectWaves, shippedBefore } from './board/model.mjs';
import { fetchPredecessors } from './board/predecessors.mjs';
import { readBoard, readJson, readNotes, readRetros, resolveRun, runBaseDir, runWaves } from './board/run.mjs';
import { deriveStage, readFamily } from './board/stage.mjs';
import { stringOption } from './lib/cli-args.mjs';
import { ghCli, ghErrorBody, ghNotFound, realRunGh, withBackoff } from './lib/gh.mjs';
import { isMain } from './lib/is-main.mjs';
import { readArg } from './lib/read-arg.mjs';
import { REPO_RE, parseRef } from './lib/ref.mjs';
import { parseBlockOn } from './review-gate.mjs';
import { runFamilyStateDirs } from './lib/wave-reports.mjs';
import { telemetryPath } from './telemetry.mjs';

const EX_USAGE = 64;
const BATCH = 40; // refs per GraphQL query
const CLOSURE_ROUNDS = 5; // extra rounds that look up open blockers outside the set
const FIELDS = 'number title url state stateReason createdAt closedAt closedByPullRequestsReferences(first:20,includeClosedPrs:true){nodes{number url state}} '
  + 'blockedBy(first:50){nodes{number state repository{nameWithOwner}}}';

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

/** Look `refs` up, `BATCH` to a query. Returns `[ref, issue]` pairs; refs GitHub has no issue for throw, named together. */
async function lookup(refs, deps) {
  const found = [];
  const missing = [];
  for (let i = 0; i < refs.length; i += BATCH) {
    const batch = refs.slice(i, i + BATCH);
    const query = `query{${batch.map((ref, j) => {
      const { repo, number } = asRef(ref);
      const [owner, name] = repo.split('/');
      return `r${j}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){issue(number:${number}){${FIELDS}}}`;
    }).join(' ')}}`;
    const { data } = await answer(query, deps);
    batch.forEach((ref, j) => (data?.[`r${j}`]?.issue ? found.push([ref, data[`r${j}`].issue]) : missing.push(ref)));
  }
  if (missing.length) throw new Error(`${missing.join(', ')}: GitHub has no such issue`);
  return found;
}

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
  const edges = spec.edges ?? [];
  const members = spec.members ?? [...nodes, ...(spec.done ?? [])];
  const retro = readRetros(run.runId, { path: telemetryPath(deps.env) }).flatMap((r) => r.filed ?? []);
  const epic = board.issueSet?.epic;
  if (board.predecessors !== undefined && !Array.isArray(board.predecessors)) throw new Error('board.json predecessors must be an array of owner/repo#N refs');
  const predecessors = [...new Set(board.predecessors ?? [])];
  predecessors.forEach((ref) => asRef(ref));
  // The walk needs nothing the lookups below return, so it runs beside them; a no-op catch keeps an early failure of
  // theirs from leaving its rejection unhandled, and the await below still throws it.
  const walk = fetchPredecessors(predecessors, (q) => answer(q, deps, ['-H', 'GraphQL-Features: sub_issues']));
  walk.catch(() => {});
  const wanted = [...new Set([...members, ...nodes, ...waves.flatMap((w) => w.refs), ...retro, ...(notes.extraRefs ?? []),
    ...edges.flatMap((e) => [e.blocked, e.blockedBy]), ...(epic ? [epic] : [])])];

  const info = new Map(); // ref → the issue GitHub returned
  const state = new Map(); // ref → OPEN | CLOSED, also for a blocker no one has looked up
  const native = []; // GitHub's own blockedBy edges
  let todo = wanted;
  for (let round = 0; todo.length; round += 1) {
    if (round > CLOSURE_ROUNDS) { warn(`closure stopped after ${CLOSURE_ROUNDS} rounds; ${todo.length} open blockers unread`); break; }
    for (const [ref, issue] of await lookup(todo, deps)) {
      info.set(ref, issue);
      state.set(ref, issue.state);
      for (const b of issue.blockedBy.nodes) {
        const blocker = `${b.repository.nameWithOwner}#${b.number}`;
        native.push({ blocked: ref, blockedBy: blocker });
        if (!state.has(blocker)) state.set(blocker, b.state);
      }
    }
    todo = [...state].filter(([ref, s]) => s === 'OPEN' && !info.has(ref)).map(([ref]) => ref);
  }

  const startedAt = Date.parse(board.startedAt);
  const dropped = (ref) => board.issueSet?.label && info.get(ref).state === 'CLOSED' && Date.parse(info.get(ref).closedAt) < startedAt;
  const refs = [...new Set([...members.filter((r) => !dropped(r)), ...waves.flatMap((w) => w.refs), ...retro, ...(notes.extraRefs ?? [])])];
  const allEdges = [...edges, ...native];
  const family = readFamily(dir, { runId: run.runId, warn, dirs });
  const latest = new Map(waves.flatMap((w) => w.refs.map((ref) => [ref, w]))); // oldest first, so the newest wave wins
  const tickets = refs.map((ref) => {
    const issue = info.get(ref);
    const prs = issue.closedByPullRequestsReferences.nodes.map((p) => ({ ...p, state: p.state.toLowerCase() }));
    const open = prs.find((p) => p.state === 'open');
    const item = notes.items?.[ref] ?? {};
    const status = classify({
      state: issue.state, stateReason: issue.stateReason, hasOpenPr: !!open, owned: item.owner === 'you',
      openBlockers: allEdges.filter((e) => e.blocked === ref && state.get(e.blockedBy) === 'OPEN').length,
    });
    const wave = issue.state === 'OPEN' && latest.get(ref);
    const derived = wave && deriveStage({ dir: wave.dir, ref, waveTs: wave.mtimeMs, family, blockOn: board.blockOn, prOpen: !!open, openPr: open?.number });
    return { ref, title: issue.title, url: issue.url, status, stage: derived || item.stage, note: item.note, prs, createdAt: issue.createdAt, closedAt: issue.closedAt, shippedWave: latest.get(ref)?.id };
  });

  const openRefs = tickets.filter((t) => t.status !== 'shipped' && t.status !== 'dropped').map((t) => t.ref);
  const graph = buildGraph(openRefs, allEdges, [...state].filter(([, s]) => s === 'CLOSED').map(([ref]) => ref));
  const newest = waves[waves.length - 1];
  const current = { id: newest.id, refs: new Set(newest.refs) };
  const before = shippedBefore(await walk, refs); // only the run's own tickets: a closed blocker outside them still shipped before
  const repos = [...refs, ...before.flatMap((g) => [g.ref, ...g.shipped.map((l) => l.ref)])].map((ref) => asRef(ref).repo);
  const shortRef = makeShortRef(repos, board.abbreviations);
  const scope = epic ? { url: info.get(epic).url, label: shortRef(epic), title: info.get(epic).title }
    : board.issueSet?.label ? { url: `https://github.com/${board.issueSet.repo}/issues?q=label%3A${encodeURIComponent(board.issueSet.label)}`, label: board.issueSet.label, title: board.issueSet.repo } : null;
  return {
    title: board.title, runId: board.runId ?? run.runId, scope, now: deps.now().toISOString(), tickets, graph, current,
    out: flag('--out') ?? board.out ?? join(dir, 'board.html'),
    waves: projectWaves(graph, new Map(tickets.map((t) => [t.ref, t.status])), current), shortRef,
    repoLabel: makeRepoLabel(repos, board.abbreviations), notes, rebuild, before, startedAt: board.startedAt,
  };
}

/** The default `fetchSpec(repo, {epic|label, members, warn})`: plan-waves', loaded on first use so `render` never needs the topo core. A replacement may be sync or async. */
const planWavesFetch = (runGhSync) => async (repo, opts) => (await import('./plan-waves.mjs')).fetchSpec(repo, opts, runGhSync);

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

/** Write `text` to `path` through a temp file beside it, so a failure leaves the old file byte-identical. */
function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
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
