// escapes.mjs — the escaped-defect proxy: for each PR ship-dag merged, did a revert or a bug-signalled
// follow-up that cites it show up within 30 days? Candidates are fetched once per repo per merge-day
// window (five `gh search` calls), cached once that day's window has closed and settled, and matched to
// merged PRs locally. `gh` is injected (`async (args) => stdout`) and the engine base dir is a parameter, so
// nothing here touches GitHub or the real state dir unless asked to.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultBaseDir } from '../rate-limit-preflight.mjs';
import { ghCli, ghJson, withBackoff } from './gh.mjs';
import { formatRef, isPr, parseRef, refKey, sameRepo } from './ref.mjs';
import { groupBy } from './stats.mjs';
import { readSidecar, SIDECAR_NAME } from './wave-sidecar.mjs';
import { readWaveReports, waveContextFor } from './wave-reports.mjs';

const DAY = 86_400_000;
const WINDOW_DAYS = 30;
// GitHub search returns at most 1000 results, so a search that reaches it may have dropped some.
const SEARCH_CAP = 1000;
// A day is cached only this long after its window closes, so a candidate GitHub indexes late still counts.
const SETTLE_DAYS = 1;
// Bump when the searches or the cached shape change, so stale caches are not read.
const CACHE_VERSION = 1;
const FIX = /\b(?:fix(?:es|ed|ing)?|regressions?)\b/i;
const PR_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/i;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const repoDir = (cacheDir, repo) => join(cacheDir, `v${CACHE_VERSION}`, refKey(repo).replace('/', '__'));
/** The JSON cached at `file`, or undefined when absent or unreadable. */
const readCached = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; } };
const writeCached = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value)); };
const lsdir = (dir) => { try { return readdirSync(dir); } catch { return []; } };

/** The GraphQL query for issue `$n` of `$owner/$name`'s state and the PRs that close it, merged or not. */
export const CLOSING_PRS_QUERY = 'query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){state closedByPullRequestsReferences(first:50,includeClosedPrs:true){nodes{number headRefName mergedAt repository{nameWithOwner}}}}}}';

/** Resolve the candidate cache directory: `$SHIP_DAG_ESCAPES_DIR`, else `escapes` beside the engine base dir. */
export function escapesDir(env = process.env) {
  return env.SHIP_DAG_ESCAPES_DIR || join(dirname(defaultBaseDir(env)), 'escapes');
}

/**
 * Whether `body`, written in repo `home`, cites `repo`#`n`: as `#n` (only when `repo` is `home`), as
 * `owner/repo#n`, or by its `/pull/n` or `/issues/n` URL. Repos compare case-insensitively, and a
 * longer number never matches.
 */
export function cites(body, repo, n, home = repo) {
  const r = escape(repo);
  const bare = sameRepo(repo, home) ? `(?<![\\w/])#${n}|` : '';
  return new RegExp(`(?:${bare}(?<![\\w./-])${r}#${n}|github\\.com/${r}/(?:pull|issues)/${n})(?!\\d)`, 'i').test(body ?? '');
}

/**
 * The PR numbers `cand`'s body says it reverts (`Reverts [owner/repo]#N` lines, and each `This reverts
 * commit <sha>` resolved through GitHub), or null when it names none. A sha GitHub could not resolve
 * sets `cand.unresolved`: 'permanent' for GitHub's 422 (it has no such commit), else 'transient' (a 5xx, a dropped connection).
 */
async function revertedPrs(cand, repo, ctx) {
  const body = cand.body ?? '';
  const lines = [...body.matchAll(/^Reverts (?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gim)];
  const shas = [...body.matchAll(/This reverts commit ([0-9a-f]{7,40})/gi)].map((m) => m[1]);
  if (!lines.length && !shas.length) return null;
  const prs = lines.filter((m) => !m[1] || sameRepo(m[1], repo)).map((m) => Number(m[2]));
  for (const sha of shas) {
    const { value, failure } = await ghJson(['api', `repos/${repo}/commits/${sha}/pulls`], `${repo}#${cand.number} reverts ${sha}, which is not resolved to a PR`, { ...ctx, repo });
    // A transient failure on any sha outranks a 422 on another: the day stays uncached until it resolves.
    if (failure && cand.unresolved !== 'transient') cand.unresolved = failure.status === 422 ? 'permanent' : 'transient';
    prs.push(...(value ?? []).map((p) => p.number));
  }
  return prs;
}

/**
 * Merge day `day`'s window candidates for `repo` (Revert-titled PRs, PRs whose body says `This reverts
 * commit`, fix- or regression-titled PRs and bug-labelled issues, each with the `reverts` its body
 * names): from `cacheDir` (an unreadable file is a miss), else searched for, and cached once the day's
 * window has closed and settled and no reverted sha failed transiently (one GitHub has no commit for is permanent: the title decides). A search that reaches GitHub's
 * result cap throws rather than truncate.
 */
async function candidatesFor(repo, day, { cacheDir, now, ...ctx }) {
  const file = join(repoDir(cacheDir, repo), `${day}.json`);
  if (existsSync(file)) {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch (err) { ctx.warn(`escapes: ${file}: unreadable cache (${err.message}); searching again`); }
  }
  const created = `${day}..${new Date(Date.parse(day) + WINDOW_DAYS * DAY).toISOString().slice(0, 10)}`;
  const search = async (kind, ...q) => {
    const found = JSON.parse(await withBackoff(() => ctx.gh(['search', kind, '--repo', repo, '--created', created, '--limit', String(SEARCH_CAP), '--json', 'number,title,body,labels,createdAt', ...q]), { repo, sleep: ctx.sleep }));
    if (found.length >= SEARCH_CAP) throw new Error(`${repo}: gh search ${kind} ${q.join(' ')} --created ${created} returned ${found.length} results, GitHub's cap, so some may be missing; nothing cached`);
    return found;
  };
  // One search per title word: GitHub applies `in:title` to neither side of an OR.
  const found = [
    ...await search('prs', '--match', 'title', 'Revert'),
    ...await search('prs', '--match', 'body', 'This reverts commit'),
    ...await search('prs', '--match', 'title', 'fix'),
    ...await search('prs', '--match', 'title', 'regression'),
    ...await search('issues', '--label', 'bug'),
  ];
  const candidates = [...new Map(found.map((c) => [c.number, c])).values()];
  for (const c of candidates) c.reverts = await revertedPrs(c, repo, ctx);
  if (!candidates.some((c) => c.unresolved === 'transient') && now >= Date.parse(day) + (WINDOW_DAYS + 1 + SETTLE_DAYS) * DAY) {
    writeCached(file, candidates);
  }
  return candidates;
}

/**
 * How `cand` escapes from the merged `pr` (`{repo, number, title, subjects, cited: [[repo, n]]}`), or null.
 * A revert whose body names what it reverts is judged by that alone; one naming nothing, or a sha GitHub
 * could not resolve, also by its `Revert "<X>"` title, X being the PR title or a commit subject.
 */
function classify(cand, pr) {
  const reverted = /^Revert "(.*)"$/.exec(cand.title ?? '')?.[1];
  const byTitle = reverted !== undefined && [pr.title, ...pr.subjects].includes(reverted);
  if (cand.reverts?.includes(pr.number) || ((!cand.reverts || cand.unresolved) && byTitle)) return 'revert';
  const signal = (cand.labels ?? []).some((l) => same(l.name, 'bug')) || FIX.test(cand.title ?? '');
  return signal && pr.cited.some(([repo, n]) => cites(cand.body, repo, n, pr.repo)) ? 'follow-up-fix' : null;
}

/** A commit's full subject: GitHub cuts a long headline at "…" and starts the body with the rest. */
const subject = (c) => (c.messageHeadline.endsWith('…') && c.messageBody?.startsWith('…') ? c.messageHeadline.slice(0, -1) + c.messageBody.slice(1).split('\n')[0] : c.messageHeadline);

/**
 * `m`'s `{mergedAt, title, subjects, closing: [[repo, n]]}` from `cacheDir`, else from `gh pr view`; a
 * merged PR's is cached, as it cannot change. Null (warned) when GitHub cannot show it.
 */
async function viewOf(m, ctx, cacheDir) {
  const file = join(repoDir(cacheDir, m.repo), `pr-${m.pr}.json`);
  const cached = readCached(file);
  if (cached) return cached;
  const { value: raw } = await ghJson(['pr', 'view', String(m.pr), '--repo', m.repo, '--json', 'mergedAt,title,commits,closingIssuesReferences'], `skipped ${m.repo}#${m.pr}`, { ...ctx, repo: m.repo });
  if (!raw) return null;
  const view = { mergedAt: raw.mergedAt, title: raw.title, subjects: raw.commits.map(subject), closing: raw.closingIssuesReferences.map((i) => [`${i.repository.owner.login}/${i.repository.name}`, i.number]) };
  if (view.mergedAt) writeCached(file, view);
  return view;
}

/**
 * For each PR `{repo, pr, tuningVersion}` that merged and whose 30-day window has closed by `now` (epoch
 * ms; one in the future is taken as the present, since GitHub is searched as of today), the reverts and
 * follow-up fixes found: `[{repo, pr, tuningVersion, mergedAt, escapes: [{number, kind}]}]`. A PR
 * GitHub cannot show is skipped with a warning; a rate limit that outlasts the backoff throws.
 * @param {{gh?: (args: string[]) => Promise<string>, cacheDir?: string, now?: number, sleep?: (ms: number) => Promise<void>, warn?: (m: string) => void}} [opts]
 */
export async function findEscapes(prs, { gh = ghCli, cacheDir = escapesDir(), now = Date.now(), sleep, warn = (m) => console.error(m) } = {}) {
  const ctx = { gh, sleep, warn, prefix: 'escapes' };
  now = Math.min(now, Date.now());
  const windows = new Map();
  const out = [];
  for (const m of prs) {
    const view = await viewOf(m, ctx, cacheDir);
    if (!view?.mergedAt) continue;
    const mergedMs = Date.parse(view.mergedAt);
    const end = mergedMs + WINDOW_DAYS * DAY;
    if (end > now) continue;
    const day = view.mergedAt.slice(0, 10);
    const key = `${refKey(m.repo)}#${day}`;
    if (!windows.has(key)) windows.set(key, candidatesFor(m.repo, day, { ...ctx, cacheDir, now }));
    const pr = { repo: m.repo, number: m.pr, title: view.title, subjects: view.subjects, cited: [[m.repo, m.pr], ...view.closing] };
    const escapes = (await windows.get(key))
      .filter((c) => c.number !== m.pr && Date.parse(c.createdAt) > mergedMs && Date.parse(c.createdAt) <= end)
      .flatMap((c) => { const kind = classify(c, pr); return kind ? [{ number: c.number, kind }] : []; });
    out.push({ ...m, mergedAt: view.mergedAt, escapes });
  }
  return out;
}

/** Escape rate overall, by merge month and by `tuningVersion`, over `findEscapes` rows. */
export function escapeReport(rows) {
  const tally = (rs) => { const escaped = rs.filter((r) => r.escapes.length).length; return { prs: rs.length, escaped, rate: rs.length ? escaped / rs.length : 0 }; };
  const by = (key) => Object.fromEntries([...groupBy(key, rows)].map(([k, rs]) => [k, tally(rs)]));
  return { total: tally(rows), byMonth: by((r) => r.mergedAt.slice(0, 7)), byTuningVersion: by((r) => String(r.tuningVersion ?? 0)) };
}

/** A report row's PR (as `prOf` reads it), or null when its ref is not `owner/repo#N`. */
const rowPr = (row) => { const ref = parseRef(row?.ref); return ref ? prOf(ref.repo, row.prNumber) : null; };
/** A record's or report row's PR as `{repo, pr}`: a positive integer in `repo`, or a PR URL (its own repo). */
function prOf(repo, pr) {
  if (isPr(pr)) return { repo, pr };
  const m = typeof pr === 'string' ? PR_URL.exec(pr) : null;
  return m ? { repo: m[1], pr: Number(m[2]) } : null;
}

/**
 * The PRs ship-dag opened, `[{repo, pr, tuningVersion}]`, once per `owner/repo#PR` (case-insensitive):
 * telemetry records' `pr` whatever their finalState (the newest record wins), then each report row's
 * `prNumber` under `baseDir/<run>/state/reports/` (its `tuningVersion` from the sidecar entry ingest-wave
 * reads for the report: `waveContextFor`; a report with a row that has no `owner/repo#N` ref, or with no
 * parseable `startedAt`, is skipped), then, for a sidecar ref neither gave a PR (nor a skipped report withheld
 * one from; a ref that is not an `owner/repo#N` string is skipped, with a warning), its one merged closing PR on an
 * `orchestrator/` branch (cached in `cacheDir` once the issue is closed), under the ref's newest
 * entry's version (none or several: skipped, with a warning, and asked again next run). Whether each merged, and when, is `findEscapes`' to ask.
 */
export async function shipDagPrs(records, { baseDir = defaultBaseDir(), cacheDir = escapesDir(), gh = ghCli, sleep, warn = (m) => console.error(m) } = {}) {
  const byPr = new Map();
  const covered = new Set(); // issue refs some source gave a PR for, or a skipped report withheld one from
  const add = (p, tuningVersion) => { const k = refKey(formatRef(p.repo, p.pr)); if (!byPr.has(k)) byPr.set(k, { ...p, tuningVersion }); };
  for (const r of records.toReversed()) {
    const p = r.kind === 'retro' ? null : prOf(r.repo, r.pr);
    if (!p) continue;
    covered.add(refKey(formatRef(r.repo, r.issue)));
    add(p, r.tuningVersion ?? 0);
  }
  const sidecarRefs = new Map(); // refKey → [ref, tuningVersion, emittedAt] of its newest entry
  for (const run of lsdir(baseDir)) {
    const entries = readSidecar(join(baseDir, run, SIDECAR_NAME), { warn });
    for (const read of readWaveReports(join(baseDir, run), { warn: (m) => warn(`escapes: ${m}; skipped`) })) {
      if (read.error) { // skipped, as ingest-wave refuses it; a parsed report's PRs must not come back through the closing-PR fallback
        for (const row of read.report?.issues ?? []) if (rowPr(row)) covered.add(refKey(row.ref));
        continue;
      }
      const rows = read.report.issues;
      const tuningVersion = waveContextFor(join(baseDir, run), read, { warn }).entry?.tuningVersion ?? 0;
      for (const row of rows) {
        const p = rowPr(row);
        if (!p) continue;
        covered.add(refKey(row.ref));
        add(p, tuningVersion);
      }
    }
    for (const e of entries) {
      const at = Date.parse(e.emittedAt) || 0;
      for (const i of e.issues ?? []) if (!(sidecarRefs.get(refKey(i.ref))?.[2] > at)) sidecarRefs.set(refKey(i.ref), [i.ref, e.tuningVersion ?? 0, at]);
    }
  }
  for (const [key, [ref, tuningVersion]] of sidecarRefs) {
    if (covered.has(key)) continue;
    const parsed = parseRef(ref);
    if (!parsed) { warn(`escapes: ${ref}: not an owner/repo#N ref; skipped`); continue; }
    const { repo, number: n } = parsed;
    const [owner, name] = repo.split('/');
    const file = join(repoDir(cacheDir, repo), `closing-${n}.json`);
    const cached = readCached(file);
    if (cached) { add(cached, tuningVersion); continue; }
    const { value: res } = await ghJson(['api', 'graphql', '-f', `query=${CLOSING_PRS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `n=${n}`], `${ref}: closing PRs not found; skipped`, { gh, repo, sleep, warn, prefix: 'escapes' });
    if (!res) continue;
    const issue = res.data?.repository?.issue;
    const hits = (issue?.closedByPullRequestsReferences?.nodes ?? []).filter((p) => p.mergedAt && p.headRefName?.startsWith('orchestrator/'));
    if (hits.length === 1) {
      const hit = { repo: hits[0].repository.nameWithOwner, pr: hits[0].number };
      if (issue.state === 'CLOSED') writeCached(file, hit); // while it is open, another closing PR could still merge
      add(hit, tuningVersion);
    }
    else warn(`escapes: ${ref}: ${hits.length} merged orchestrator/ PRs close it, so it has no PR; skipped`);
  }
  return [...byPr.values()];
}
