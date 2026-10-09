// wave-records.mjs — derive a wave's telemetry issue records from the engine's own
// artifacts, so emission is a consequence of the wave rather than a reminder.
//
// Pure: the caller reads the files (the report, the wave's sidecar entry from
// `findWaveContext`, the failure digests, the review files) and hands the parsed
// contents in. Only `--outcomes` supplies what no artifact records: `hitl.pointB`,
// a manual `finalState`, a PR the report row lacks, and a floor for `bounces`.
import { join } from 'node:path';
import { DEFAULT_BLOCK_ON, gateReview } from '../review-gate.mjs';
import { defaultBaseDir } from '../rate-limit-preflight.mjs';
import { artifactStem, routeFailure } from './failure.mjs';
import { runIdFromConfigName } from './run-id.mjs';
import { load as loadTuning } from './tuning.mjs';

const SEVERITY = { clean: 0, 'nits-only': 1, blocking: 2 };

/**
 * The round files for `ref` among `files` (`{name, review}`), oldest first: the
 * bare `<stem>.json`, then `.rN` by number, then any other dot-tag (`.pass3-skills`)
 * by name. The `.` after the stem keeps `#1` from claiming `#12`'s files.
 */
export function roundFilesFor(ref, files) {
  const stem = artifactStem(ref);
  const rank = (name) => {
    if (name === `${stem}.json`) return [0, 0, ''];
    const tag = name.slice(stem.length + 1, -'.json'.length);
    const n = /^r(\d+)$/.exec(tag);
    return n ? [1, Number(n[1]), ''] : [2, 0, tag];
  };
  return files
    .filter((f) => f.name.startsWith(`${stem}.`) && f.name.endsWith('.json'))
    .sort((a, b) => {
      const [x, y] = [rank(a.name), rank(b.name)];
      return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]);
    });
}

/** One round's verdict: unreadable (no findings array, or an empty round beside its `.raw`) is `blocking`. */
function roundVerdict(file, files, blockOn) {
  const raw = files.some((f) => f.name === `${file.name}.raw`);
  if (raw && file.review?.findings?.length === 0) return 'blocking';
  try { return gateReview(file.review, blockOn).verdict; } catch { return 'blocking'; }
}

/**
 * Derive one telemetry issue record per row of the wave `report`.
 * @param {object} report parsed `<stateDir>/state/reports/<id>.json`
 * @param {object|null} entry this wave's sidecar entry (`findWaveContext`), or null
 * @param {Record<string, object>} digests failure digests by ref
 * @param {Array<{name: string, review?: object|null}>} reviewFiles every file in `$STATE/reviews`; `review` is null when unparseable, and `.raw` siblings are named entries
 * @param {Record<string, object>} outcomes per-ref `{pr, hitl, finalState, bounces, findings, tokens}`
 * @param {{stateDir?: string, existing?: object[], warn?: (m: string) => void, tuningVersion?: unknown}} [opts]
 *   `existing` records are deduped against on `runId+ref+finalState+failureReason`
 * @returns {{records: object[]}}
 * @throws when a `succeeded` row has no PR in the report or the outcomes
 */
export function deriveWaveRecords(report, entry, digests, reviewFiles, outcomes, { stateDir, existing = [], warn = (m) => console.error(m), tuningVersion } = {}) {
  const rows = Array.isArray(report?.issues) ? report.issues : [];
  const runId = entry?.runId || runIdFromConfigName(report?.configName);
  const blockOn = entry?.blockOn ?? DEFAULT_BLOCK_ON;
  const dir = stateDir ?? join(defaultBaseDir(), runId ?? '');
  const files = reviewFiles ?? [];
  const keys = new Set(existing.map((r) => `${r.runId}|${r.repo}#${r.issue}|${r.finalState}|${r.failureReason}`));

  const halfSupplied = rows.filter((r) => r.status === 'succeeded' && !r.prNumber && !outcomes?.[r.ref]?.pr).map((r) => r.ref);
  if (halfSupplied.length) throw new Error(`half-supplied wave: succeeded with no PR in the report or --outcomes: ${halfSupplied.join(', ')}`);

  const records = [];
  for (const row of rows) {
    const m = /^(.+)#(\d+)$/.exec(row.ref ?? '');
    if (!m) throw new Error(`half-supplied wave: row without an owner/repo#N ref: ${JSON.stringify(row)}`);
    const outcome = outcomes?.[row.ref] ?? {};
    const planned = (entry?.issues ?? []).find((i) => i.ref === row.ref);
    const pr = row.prNumber ?? outcome.pr ?? null;
    const failureReason = (digests?.[row.ref]?.failureReason ?? row.failureReason) === 'rate-limited' ? 'rate-limited' : null;
    const reviewed = routeFailure({ ...row, prNumber: pr, failureReason }) === 'review-gate';

    const rounds = roundFilesFor(row.ref, files);
    const verdicts = rounds.map((f) => roundVerdict(f, files, blockOn));
    // A round is a bounce when the round before it blocked; a re-gate after a clean
    // round (a rebase moving the base) is not.
    const bounced = verdicts.map((_, i) => i > 0 && verdicts[i - 1] === 'blocking');
    rounds.forEach((f, i) => {
      const trigger = f.review?.meta?.trigger;
      if (trigger && i > 0 && (trigger === 'review-loop') !== bounced[i]) warn(`${row.ref}: ${f.name} says trigger "${trigger}" but its predecessor ${verdicts[i - 1]}`);
    });

    const rec = {
      runId,
      repo: m[1],
      issue: Number(m[2]),
      complexity: planned?.complexity ?? 'normal',
      triageStatus: 'clear',
      assignment: planned?.model ?? null,
      effort: planned?.effort ?? null,
      effortSource: planned?.effortSource ?? null,
      model: planned?.model ?? null,
      path: 'engine',
      implStatus: reviewed ? 'pushed' : row.status === 'blocked' ? 'blocked' : 'error',
      ciStatus: row.status === 'succeeded' ? 'pass' : null,
      reviewVerdict: verdicts.length ? verdicts.reduce((w, v) => (SEVERITY[v] > SEVERITY[w] ? v : w)) : null,
      reviewPath: join(dir, 'reviews', `${artifactStem(row.ref)}.json`),
      failureReason,
      findings: outcome.findings ?? [],
      bounces: Math.max(outcome.bounces ?? 0, bounced.filter(Boolean).length),
      hitl: { pointA: false, pointB: !!outcome.hitl?.pointB },
      finalState: outcome.finalState ?? (pr ? 'merged' : 'error'),
      pr,
      tokens: outcome.tokens ?? null,
      policySource: entry?.blockOn ? 'sidecar' : 'default',
      tuningVersion: entry?.tuningVersion ?? tuningVersion ?? loadTuning().version,
      ts: report.finishedAt || report.startedAt,
    };
    const key = `${rec.runId}|${row.ref}|${rec.finalState}|${rec.failureReason}`;
    if (keys.has(key)) continue;
    keys.add(key);
    records.push(rec);
  }
  return { records };
}
