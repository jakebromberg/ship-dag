// engine-fixture.mjs — test support: builds the on-disk layout the engine leaves for a run, so no test hand-rolls it.
// Not a test file (no `.test.mjs`), so `node --test` does not run it.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendWave } from './wave-sidecar.mjs';
import { artifactStem } from './failure.mjs';
import { parseRef } from './ref.mjs';

export const RUN = 'sd-20261008-153059';
export const T0 = '2026-10-08T19:00:00.000Z';
export const T1 = '2026-10-08T20:00:00.000Z';
/** When configs are emitted unless stamped otherwise: before the wave that starts at T0, as emit-config always is. */
export const EMITTED = '2026-10-08T18:55:00.000Z';

const secs = (iso) => Date.parse(iso) / 1000;
const text = (body) => (typeof body === 'string' ? body : JSON.stringify(body));
const STAMP = Symbol('stamped');
/** `ref`'s `{repo, number}`, or a throw: a fixture built on a malformed ref would test nothing. */
const refParts = (ref) => parseRef(ref) ?? (() => { throw new Error(`not an owner/repo#N ref: ${JSON.stringify(ref)}`); })();

/** `body` to write with file mtime `at` (an ISO string), for a `configs` or `files` value that needs its mtime pinned. */
export const stamped = (at, body) => ({ [STAMP]: true, at, body });

function put(path, body, at) {
  const [contents, mtime] = body?.[STAMP] ? [body.body, body.at] : [body, at];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text(contents));
  if (mtime) utimesSync(path, secs(mtime), secs(mtime));
}

/** Write report `name` (`w1.json`) under `dir`'s `state/reports/`; a string `body` is written as is (a torn file). */
export const putReport = (dir, name, body) => put(join(dir, 'state', 'reports', name), body);
/** Write a review round for `ref` as `<dir>/reviews/<stem><tag>.json` with mtime `at`; `findings` is an array, or a string written as is. */
export const putReview = (dir, ref, tag, findings, at) =>
  put(join(dir, 'reviews', `${artifactStem(ref)}${tag}.json`), typeof findings === 'string' ? findings : { issue: 1, findings }, at);
/** Write `ref`'s failure digest as `<dir>/state/failure-digest/issue-<stem>.json` with mtime `at` (by default inside a wave started at T0). */
export const putDigest = (dir, ref, body, at = '2026-10-08T19:30:00.000Z') =>
  put(join(dir, 'state', 'failure-digest', `issue-${artifactStem(ref)}.json`), body, at);

/**
 * Build a base dir of engine state dirs, one per key of `dirs`, and return `{ base, dirs, cleanup }`
 * (`dirs` maps each name to its absolute path; `cleanup` removes `base`). Each dir's spec writes:
 *
 * - `reports`: name → report, to `<dir>/state/reports/<name>` (a string is written as is, e.g. a torn report);
 *   the dir's `state/reports/` exists even when empty.
 * - `sidecar`: entries appended through `appendWave` to `<dir>/ship-dag-wave.jsonl`.
 * - `configs`: path under the dir → config, e.g. `config.json`, `config-2.json` or `state/config.json`;
 *   mtime is EMITTED unless the value is `stamped(at, config)`.
 * - `reviews`: `{ref, tag, findings, at}` rounds, to `<dir>/reviews/<stem><tag>.json`.
 * - `digests`: `{ref, body, at}` to `<dir>/state/failure-digest/issue-<stem>.json`.
 * - `files`: any other path under the dir → contents (a string as is, anything else as JSON; `stamped` pins mtime),
 *   also the way to write a deliberately malformed file.
 */
export function engineFixture(specs) {
  const base = mkdtempSync(join(tmpdir(), 'engine-fixture-'));
  const dirs = {};
  try {
    for (const [name, { reports = {}, sidecar = [], configs = {}, reviews = [], digests = [], files = {} }] of Object.entries(specs)) {
      const dir = (dirs[name] = join(base, name));
      mkdirSync(join(dir, 'state', 'reports'), { recursive: true });
      for (const [n, rep] of Object.entries(reports)) putReport(dir, n, rep);
      for (const entry of sidecar) if (!appendWave(dir, entry)) throw new Error(`${dir}: appendWave did not write ${JSON.stringify(entry)}`);
      for (const [rel, cfg] of Object.entries(configs)) put(join(dir, rel), cfg, EMITTED);
      for (const r of reviews) putReview(dir, r.ref, r.tag ?? '', r.findings, r.at);
      for (const d of digests) putDigest(dir, d.ref, d.body, d.at);
      for (const [rel, body] of Object.entries(files)) put(join(dir, rel), body);
    }
  } catch (err) {
    rmSync(base, { recursive: true, force: true }); // a half-built fixture is never returned, so nothing else would remove it
    throw err;
  }
  return { base, dirs, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** A report row for `ref` (an `owner/repo#N` string; any other is kept as is, with `number` null, for the malformed-row refusal tests) that succeeded with PR 11; `over` overrides any field, among them the engine's `ran` (whether it launched a session) and `sessionIds` (the sessions it launched). A row given neither is a pre-change row. */
export const stateRow = (ref, over = {}) => ({ ref, number: parseRef(ref)?.number ?? null, status: 'succeeded', prUrl: 'https://x/11', prNumber: 11, ...over });
/** A wave report over `rows`, run RUN's wave from T0 to T1. */
export const stateReport = (rows, over = {}) => ({ configName: `ship-dag-${RUN}`, startedAt: T0, finishedAt: T1, issues: rows, ...over });
/** A sidecar entry routing `refs` as complex/high/opus for RUN's wave 1. */
export const sidecarEntry = (refs = ['WXYC/dj-site#1']) => ({
  runId: RUN, wave: 1, tuningVersion: 7, blockOn: ['correctness'],
  issues: refs.map((ref) => ({ ref, complexity: 'complex', effort: 'high', effortSource: 'tuning', model: 'opus' })),
});
/** An engine config for RUN over `refs`; `over` overrides any field. */
export const engineConfig = (refs = ['WXYC/dj-site#1'], over = {}) => ({
  name: `ship-dag-${RUN}`, defaultModel: 'sonnet', defaultEffort: 'medium',
  issues: refs.map((ref) => { const { repo, number } = refParts(ref); return { repo, number }; }),
  ...over,
});
