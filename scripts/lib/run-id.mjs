// run-id.mjs — mint, parse and compare run identifiers.
//
// A run's id appears in several spellings: the telemetry log's `runId`, the
// engine config `name` (`ship-dag-<runId>`), and the engine state dir (which
// grows per-wave and retry suffixes). `sameRun` is how they are matched.
// Pure: no I/O, no globals, no clock beyond an injected `now`.

import { runFamily } from '../../plugins/ship-dag-eta/lib/run-id.mjs';
export { canonicalRunId, runFamily } from '../../plugins/ship-dag-eta/lib/run-id.mjs';

const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * Mint a run identifier: `sd-<YYYYMMDD>-<HHMMSS>` in **local** time, plus an
 * optional slugged label. Minting in a script rather than in the agent's head
 * lets the shell export the id once (`SHIP_DAG_RUN_ID`) and survive compaction.
 * @param {{now?: Date, label?: string}} [opts]
 * @returns {string}
 */
export function mintRunId({ now = new Date(), label } = {}) {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const slug = String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug ? `sd-${stamp}-${slug}` : `sd-${stamp}`;
}

/**
 * Recover the runId from an engine config `name` (`ship-dag-<runId>`). A name
 * without the prefix is returned as-is.
 * @param {string|undefined|null} name
 * @returns {string|null}
 */
export function runIdFromConfigName(name) {
  if (typeof name !== 'string' || !name) return null;
  return name.startsWith('ship-dag-') ? name.slice('ship-dag-'.length) : name;
}

/**
 * Whether two run ids name the same run (or run family): wave suffixes, retry
 * letters, the `ship-dag-` prefix and case are all folded away.
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {boolean}
 */
export function sameRun(a, b) {
  const fa = runFamily(a);
  return fa !== null && fa === runFamily(b);
}
