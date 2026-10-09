// transcript-cost.mjs — the implement cost of a ref, from the session `result` records in its
// stream-json transcript. Only sessions that wrote a result record with a cost are counted: one the
// engine killed, or that died hard, wrote none, and its spend is missing. The transcript may be
// megabytes, so it is read in chunks, a line at a time, never whole.
//
// A session that wakes for a background-task notification writes a result record per wake
// (`result_index` 0, 1, 2…). Their `total_cost_usd` is the session's running total, while each
// `usage` is that result's own, so a session's cost is its last record's and its tokens are summed.
// `usage` covers the session's main model only, while `total_cost_usd` also covers its subagents and
// side calls (`modelUsage`, which some CLI versions repeat whole on every result), so the token counts
// can fall short of what `costUsd` paid for.

import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { isSessionResult, RESULT_TYPE_KEY } from './failure.mjs';

const CHUNK = 64 * 1024;
const USAGE = { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheCreate: 'cache_creation_input_tokens' };

/** A cost in USD: a finite number, not negative. */
export const isUsd = (v) => Number.isFinite(v) && v >= 0;
/** A token or session count: a non-negative integer. */
export const isCount = (v) => Number.isInteger(v) && v >= 0;

/** Call `onLine` with each line of the file at `path`. Only newly read text is split, so a long line is scanned once. */
function eachLine(path, onLine) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    const decoder = new StringDecoder('utf8');
    let tail = '';
    for (let n; (n = readSync(fd, buf, 0, CHUNK, null)) > 0;) {
      const text = decoder.write(buf.subarray(0, n));
      const cut = text.lastIndexOf('\n');
      if (cut === -1) { tail += text; continue; }
      const lines = text.slice(0, cut).split('\n');
      lines[0] = tail + lines[0];
      tail = text.slice(cut + 1);
      lines.forEach(onLine);
    }
    onLine(tail + decoder.end());
  } finally {
    closeSync(fd);
  }
}

/**
 * Sum the implement cost over the sessions in the transcript at `path` whose `session_id` is not in
 * `counted` (the ids an earlier record for the ref's run family already lists), counting each session
 * once: its `costUsd` is its last result's `total_cost_usd` (by `result_index`, else file order) and
 * its tokens are its results' `usage` summed (an absent `usage` field counts as 0). A non-number value
 * is warned about and not summed, and so is a result with no `session_id`, which could not be counted
 * once. A session none of whose results has a valid `total_cost_usd` is unpriced, not free: it is
 * warned about and left out whole, like a session that wrote no result.
 * @param {string} path
 * @param {string[]} [counted]
 * @param {(m: string) => void} [warn]
 * @returns {{costUsd:number, input:number, output:number, cacheRead:number, cacheCreate:number, sessions:number, sessionIds:string[]}|null}
 *   null when the log is missing, unreadable (warned) or holds no uncounted session
 */
export function implementCost(path, counted = [], warn = () => {}) {
  const sessions = new Map();
  /** `v` when `ok`; undefined when absent, or (warned) when it is not a valid `field`. */
  const valid = (v, ok, field) => {
    if (v === undefined || ok(v)) return v;
    warn(`${path}: a session result has ${field} ${JSON.stringify(v)}, not a valid number; not summed`);
  };
  const add = (rec) => {
    const id = rec.session_id;
    if (typeof id !== 'string') {
      warn(`${path}: a session result has no session_id, so it cannot be counted once; not summed`);
      return;
    }
    if (counted.includes(id)) return;
    if (!sessions.has(id)) sessions.set(id, { at: -Infinity, costUsd: undefined, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
    const s = sessions.get(id);
    for (const [k, field] of Object.entries(USAGE)) s[k] += valid(rec.usage?.[field], isCount, `usage.${field}`) ?? 0;
    const usd = valid(rec.total_cost_usd, isUsd, 'total_cost_usd');
    const at = Number.isInteger(rec.result_index) ? rec.result_index : s.at;
    if (usd !== undefined && at >= s.at) Object.assign(s, { costUsd: usd, at });
  };
  try {
    eachLine(path, (line) => {
      if (!line.includes(RESULT_TYPE_KEY)) return;
      let rec;
      try { rec = JSON.parse(line); } catch { return; }
      if (isSessionResult(rec)) add(rec);
    });
  } catch (err) {
    if (err.code !== 'ENOENT') warn(`${path}: cannot read the transcript (${err.message}); no cost recorded`);
    return null;
  }
  for (const [id, s] of sessions) {
    if (s.costUsd !== undefined) continue;
    warn(`${path}: session ${id} wrote no valid total_cost_usd; not counted`);
    sessions.delete(id);
  }
  if (!sessions.size) return null;
  const cost = { costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: sessions.size, sessionIds: [...sessions.keys()] };
  for (const s of sessions.values()) for (const k of ['costUsd', ...Object.keys(USAGE)]) cost[k] += s[k];
  return cost;
}
