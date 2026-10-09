// escapes.mjs — the escaped-defect proxy: for each PR ship-dag merged, did a revert or a bug-signalled
// follow-up that cites it show up within 30 days? Candidates are fetched once per repo per merge-day
// window (three `gh search` calls) and cached, then matched to merged PRs locally. `gh` is injected
// (`async (args) => stdout`), so nothing here touches GitHub or the real state dir unless asked to.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { groupBy } from './stats.mjs';

const DAY = 86_400_000;
const WINDOW_DAYS = 30;
const RATE_LIMITED = /rate limit/i;

/** Resolve the candidate cache directory the way `telemetryPath` resolves the log. */
export function escapesDir(env = process.env) {
  if (env.SHIP_DAG_ESCAPES_DIR) return env.SHIP_DAG_ESCAPES_DIR;
  return `${env.XDG_STATE_HOME || `${env.HOME}/.local/state`}/ship-dag/escapes`;
}

/** The default `gh`: run the CLI and return stdout. */
export const ghCli = async (args) => (await promisify(execFile)('gh', args, { maxBuffer: 64 << 20 })).stdout;

/** Whether `body` cites PR `n` of `repo`: `#n` (not a prefix of a longer number) or the PR's URL. */
export function cites(body, repo, n) {
  return new RegExp(`(?<![\\w/])#${n}(?!\\d)|github\\.com/${repo}/pull/${n}(?!\\d)`).test(body ?? '');
}

/**
 * Run `fn`, retrying a GitHub rate-limit error with doubling waits (2s, 4s, ...). After `retries`
 * retries it throws, naming `repo`; any other error is thrown as is.
 */
export async function withBackoff(fn, { repo, retries = 3, baseMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await fn(); } catch (err) {
      if (!RATE_LIMITED.test(err.message)) throw err;
      if (attempt >= retries) throw new Error(`${repo}: GitHub search rate limit persisted after ${retries} retries: ${err.message}`);
      await sleep(baseMs * 2 ** attempt);
    }
  }
}

/** The window's candidates for `repo`: cached under `cacheDir`, else three searches. */
async function candidatesFor(repo, day, { gh, cacheDir, sleep }) {
  const file = join(cacheDir, repo.replace('/', '__'), `${day}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const created = `${day}..${new Date(Date.parse(day) + WINDOW_DAYS * DAY).toISOString().slice(0, 10)}`;
  const fields = 'number,title,body,labels,createdAt';
  const search = (kind, ...q) => withBackoff(async () => JSON.parse(await gh(['search', kind, '--repo', repo, '--created', created, '--limit', '100', '--json', fields, ...q])), { repo, sleep });
  const found = [
    ...await search('prs', '--match', 'title', 'Revert'),
    ...await search('prs', '--', 'fix OR regression in:title'),
    ...await search('issues', '--label', 'bug'),
  ];
  const candidates = [...new Map(found.map((c) => [c.number, c])).values()];
  mkdirSync(join(cacheDir, repo.replace('/', '__')), { recursive: true });
  writeFileSync(file, JSON.stringify(candidates));
  return candidates;
}

/** How `cand` escapes from the merged `pr` (`{repo, number, title, commits, closing}`), or null. */
function classify(cand, pr) {
  const shas = [...(cand.body ?? '').matchAll(/This reverts commit ([0-9a-f]{7,40})/gi)].map((m) => m[1].toLowerCase());
  if (shas.some((s) => pr.commits.some((oid) => oid.startsWith(s) || s.startsWith(oid))) || (/^revert/i.test(cand.title) && cand.title.includes(pr.title))) return 'revert';
  const signal = (cand.labels ?? []).some((l) => l.name === 'bug') || /fix|regression/i.test(cand.title);
  const cited = [pr.number, ...pr.closing].some((n) => cites(cand.body, pr.repo, n));
  return signal && cited ? 'follow-up-fix' : null;
}

/**
 * For each merged PR `{repo, pr, tuningVersion}` whose 30-day window has closed by `now` (epoch ms),
 * the revert or follow-up fixes found: `[{repo, pr, tuningVersion, mergedAt, escapes: [{number, kind}]}]`.
 * @param {{gh?: (args: string[]) => Promise<string>, cacheDir?: string, now?: number, sleep?: (ms: number) => Promise<void>}} [opts]
 */
export async function findEscapes(merged, { gh = ghCli, cacheDir = escapesDir(), now = Date.now(), sleep } = {}) {
  const out = [];
  for (const m of merged) {
    const view = JSON.parse(await withBackoff(() => gh(['pr', 'view', String(m.pr), '--repo', m.repo, '--json', 'mergedAt,title,commits,closingIssuesReferences']), { repo: m.repo, sleep }));
    const mergedMs = Date.parse(view.mergedAt);
    const end = mergedMs + WINDOW_DAYS * DAY;
    if (!(end <= now)) continue;
    const pr = { repo: m.repo, number: m.pr, title: view.title, commits: view.commits.map((c) => c.oid), closing: view.closingIssuesReferences.map((i) => i.number) };
    const candidates = await candidatesFor(m.repo, view.mergedAt.slice(0, 10), { gh, cacheDir, sleep });
    const escapes = candidates
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

/** The PRs ship-dag merged, from telemetry records: `[{repo, pr, tuningVersion}]`, one per PR (the newest record wins). */
export function mergedPrs(records) {
  const byPr = new Map();
  for (const r of records) {
    if (r.kind !== 'retro' && r.finalState === 'merged' && Number.isInteger(r.pr) && r.pr > 0) byPr.set(`${r.repo}#${r.pr}`, { repo: r.repo, pr: r.pr, tuningVersion: r.tuningVersion ?? 0 });
  }
  return [...byPr.values()];
}
