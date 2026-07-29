// results.mjs — persist eval scorecards, NEVER overwriting a prior run.
//
// Scorecards land as one JSON file per runId under the XDG state dir, OUTSIDE
// the ~/.claude repo (same rationale as telemetry: collected run data must never
// be committable). writeResults refuses to overwrite an existing runId — a
// completed study is expensive to reproduce, so a runId collision is an error,
// not a silent clobber. fs is injected so the pure path logic is unit-testable.
// Run tests: node --test "skills/ship-dag/eval/**/*.test.mjs"

import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';

const defaultFs = { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync };

/** Resolve the results directory: $SHIP_DAG_EVAL_RESULTS, else $XDG_STATE_HOME/…, else ~/.local/state/…. */
export function resultsDir(env = process.env) {
  if (env.SHIP_DAG_EVAL_RESULTS) return env.SHIP_DAG_EVAL_RESULTS;
  const base = env.XDG_STATE_HOME || `${env.HOME}/.local/state`;
  return `${base}/ship-dag/eval-results`;
}

/**
 * Write a scorecard to `<dir>/<runId>.json`. Throws if a file for that runId
 * already exists (never overwrite collected data) or the scorecard has no runId.
 * @returns {string} the path written
 */
export function writeResults(scorecard, { dir = resultsDir(), fs = defaultFs } = {}) {
  if (!scorecard || !scorecard.runId) throw new Error('scorecard.runId is required');
  const path = `${dir}/${scorecard.runId}.json`;
  if (fs.existsSync(path)) throw new Error(`results already exist (never overwritten): ${path}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path, `${JSON.stringify(scorecard, null, 2)}\n`);
  return path;
}

/** Read back a persisted scorecard by runId. */
export function readResults(runId, { dir = resultsDir(), fs = defaultFs } = {}) {
  return JSON.parse(fs.readFileSync(`${dir}/${runId}.json`, 'utf8'));
}

/** List persisted runIds (sorted). Missing dir → []. */
export function listResults({ dir = resultsDir(), fs = defaultFs } = {}) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}
