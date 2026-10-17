// state.mjs — gather a run's ETA inputs from its state dirs and GitHub, through an injected `io` and `gh`.
//
// No Node imports: the CLI passes fs-backed `io` and the gh CLI, and any other host (one with no Node, say) passes
// its own. Every state dir is read, never written.
//
//   io = { list(dir) → [{name, isDir}] ([] when absent), read(path) → text|null, mtime(path) → ms|null }
//   gh = async (args) → stdout; throws when gh is missing or the call fails

import { estimate } from './model.mjs';

const ID_RE = /^(?:sd|ship-dag)-(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)/;
const WAVE_DIR_RE = /-w\d+[a-z]*$/i;
const REF_RE = /^([^/\s#]+\/[^/\s#]+)#(\d+)$/;

/** `{repo, number}` of an `owner/repo#N` ref, or null. */
export function parseRef(ref) {
  const m = REF_RE.exec(String(ref));
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/** The start a run id encodes, in the local time `mintRunId` writes it in, as epoch ms; null when it encodes none. */
export function runStartFromId(runId) {
  const m = ID_RE.exec(runId);
  if (!m) {
    return null;
  }
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

/**
 * The newest run under `base` by the start its id encodes that holds a fetched DAG (`dag.json` or `dag.new.json`);
 * wave dirs (`-w1b`) and dirs with no DAG (a board's, a retry's) are passed over. Null when there is none.
 */
export async function latestRun(io, base) {
  const runs = (await io.list(base)).filter((e) => e.isDir && runStartFromId(e.name) !== null && !WAVE_DIR_RE.test(e.name)).map((e) => e.name);
  runs.sort((a, b) => runStartFromId(b) - runStartFromId(a) || b.localeCompare(a));
  for (const name of runs) {
    const times = await Promise.all(['dag.new.json', 'dag.json'].map((f) => io.mtime(`${base}/${name}/${f}`)));
    if (times.some((t) => t !== null)) {
      return name;
    }
  }
  return null;
}

/** The run's dir and its wave dirs (`<runId>-w1b`, ...), the run's first. */
async function familyDirs(io, base, runId) {
  const names = (await io.list(base)).filter((e) => e.isDir && e.name.startsWith(`${runId}-`) && WAVE_DIR_RE.test(e.name)).map((e) => e.name);
  return [runId, ...names.sort()].map((n) => `${base}/${n}`);
}

async function readJson(io, path) {
  const text = await io.read(path);
  try {
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/** The newer by mtime of `<stem>.new.json` and `<stem>.json` in `dir`, parsed, or null. */
async function newer(io, dir, stem) {
  const paths = [`${dir}/${stem}.new.json`, `${dir}/${stem}.json`];
  const times = await Promise.all(paths.map((p) => io.mtime(p)));
  const order = paths.map((p, i) => [p, times[i]]).filter(([, t]) => t !== null).sort((a, b) => b[1] - a[1]);
  for (const [path] of order) {
    const json = await readJson(io, path);
    if (json) {
      return json;
    }
  }
  return null;
}

/** What the run's state dirs hold: scope, plan, blocked refs, each ref's first engine activity and its report PR. */
export async function readRun(io, base, runId) {
  const runDir = `${base}/${runId}`;
  const spec = await newer(io, runDir, 'dag');
  if (!spec) {
    throw new Error(`no dag.json in ${runDir}: the run has not fetched its DAG yet (SKILL.md step 1)`);
  }
  const plan = (await newer(io, runDir, 'plan')) ?? { waves: [], blocked: [], cyclic: [] };
  const openAtFetch = new Set((spec.nodes ?? []).map((n) => n.ref));
  const scope = spec.members ?? [...openAtFetch];
  const startedAt = new Map();
  const prByRef = new Map();
  for (const dir of await familyDirs(io, base, runId)) {
    for (const ref of scope) {
      const at = Date.parse((await readJson(io, `${dir}/state/metadata/issue-${encodeURIComponent(ref)}.json`))?.startedAt);
      if (!Number.isNaN(at) && !(startedAt.get(ref) <= at)) {
        startedAt.set(ref, at);
      }
    }
    for (const e of (await io.list(`${dir}/state/reports`)).filter((x) => x.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))) {
      const report = await readJson(io, `${dir}/state/reports/${e.name}`);
      for (const row of report?.issues ?? report?.rows ?? []) {
        if (Number.isInteger(row?.prNumber) && parseRef(row.ref)) {
          prByRef.set(row.ref, row.prNumber);
        }
      }
    }
  }
  const blocked = [...(plan.blocked ?? []).map((b) => b.ref), ...(plan.cyclic ?? [])].filter((r) => scope.includes(r));
  return { scope, openAtFetch, waves: plan.waves ?? [], blocked, startedAt, prByRef };
}

/** One GraphQL query for every ref's issue state and every PR's merge time, aliased per repo as `r<i>`. */
export function liveQuery(refs, prs) {
  const byRepo = new Map();
  const add = (repo, field) => byRepo.set(repo, [...(byRepo.get(repo) ?? []), field]);
  for (const { repo, number } of refs.map(parseRef).filter(Boolean)) {
    add(repo, `i${number}: issue(number: ${number}) { state stateReason closedAt closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { mergedAt } } }`);
  }
  for (const { repo, number } of prs) {
    add(repo, `p${number}: pullRequest(number: ${number}) { mergedAt }`);
  }
  const repos = [...byRepo.keys()];
  const parts = repos.map((repo, i) => {
    const [owner, name] = repo.split('/');
    return `r${i}: repository(owner: "${owner}", name: "${name}") { ${[...new Set(byRepo.get(repo))].join(' ')} }`;
  });
  return { text: `query { ${parts.join(' ')} }`, repos };
}

/** Each ref's live `{open, mergedAt}` from GitHub, in one call: the report's merged PR, else a closing PR, else `closedAt`. */
export async function fetchLive(refs, prByRef, gh) {
  const prs = [...prByRef].map(([ref, number]) => ({ repo: parseRef(ref).repo, number }));
  const { text, repos } = liveQuery(refs, prs);
  const data = JSON.parse(await gh(['api', 'graphql', '-f', `query=${text}`])).data ?? {};
  const live = new Map();
  for (const ref of refs) {
    const { repo, number } = parseRef(ref) ?? {};
    const node = data[`r${repos.indexOf(repo)}`] ?? {};
    const issue = node[`i${number}`];
    if (!issue) {
      continue;
    }
    const closing = issue.closedByPullRequestsReferences?.nodes?.map((n) => n.mergedAt).filter(Boolean).sort().at(-1);
    const merged = node[`p${prByRef.get(ref)}`]?.mergedAt ?? closing ?? (issue.stateReason === 'NOT_PLANNED' ? null : issue.closedAt);
    live.set(ref, { open: issue.state === 'OPEN', mergedAt: issue.state === 'OPEN' || !merged ? null : Date.parse(merged) });
  }
  return live;
}

/**
 * The ETA of `runId` (default: the newest run under `base`), or `{error}` when there is no run or no DAG. Without
 * gh, open tickets are the fetched DAG's and no merge times are read; a note says so.
 * @param {{io: object, gh: Function, base: string, runId?: string, now: number, warn?: (m: string) => void}} args
 */
export async function computeEta({ io, gh, base, runId, now, warn = () => {} }) {
  const id = runId ?? (await latestRun(io, base));
  if (!id) {
    return { error: `no ship-dag run under ${base}` };
  }
  let run;
  try {
    run = await readRun(io, base, id);
  } catch (err) {
    return { error: err.message };
  }
  warn(`run ${id}: ${run.scope.length} tickets in scope, ${run.blocked.length} blocked, ${run.prByRef.size} report PRs`);
  const notes = [];
  let live = new Map();
  try {
    live = await fetchLive(run.scope, run.prByRef, gh);
  } catch (err) {
    const why = err.code === 'ENOENT' ? 'gh is not installed' : String(err.message).split('\n')[0];
    notes.push(`gh unavailable (${why}): open tickets are the fetched DAG's, and no merge times were read`);
    warn(notes.at(-1));
  }
  const nodes = run.scope.map((ref) => ({
    ref, repo: parseRef(ref)?.repo ?? ref, startedAt: run.startedAt.get(ref) ?? null,
    ...(live.get(ref) ?? { open: run.openAtFetch.has(ref), mergedAt: null }),
  }));
  const runStart = Math.min(runStartFromId(id) ?? Infinity, ...run.startedAt.values());
  return { runId: id, runStart, ...estimate({ now, runStart, nodes, blocked: run.blocked, waves: run.waves }), notes };
}
