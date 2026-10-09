// transcript-cost.mjs — the exact implement cost of a ref: the sum over the session `result`
// records in its stream-json transcript. The transcript may be megabytes, so it is read in
// chunks, a line at a time, never whole.

import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { isSessionResult } from './failure.mjs';

const CHUNK = 64 * 1024;

/** Call `onLine` with each line of the file at `path`. */
function eachLine(path, onLine) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    const decoder = new StringDecoder('utf8');
    let tail = '';
    for (let n; (n = readSync(fd, buf, 0, CHUNK, null)) > 0;) {
      const lines = (tail + decoder.write(buf.subarray(0, n))).split('\n');
      tail = lines.pop();
      lines.forEach(onLine);
    }
    onLine(tail + decoder.end());
  } finally {
    closeSync(fd);
  }
}

/**
 * Sum `total_cost_usd` and `usage` over the session `result` records in the transcript at `path`
 * whose `session_id` is not in `counted` (the ids an earlier record for the ref already lists).
 * @param {string} path
 * @param {string[]} [counted]
 * @returns {{costUsd:number, input:number, output:number, cacheRead:number, cacheCreate:number, sessions:number, sessionIds:string[]}|null}
 *   null when the log is unreadable or holds no uncounted session
 */
export function implementCost(path, counted = []) {
  const cost = { costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0, sessionIds: [] };
  try {
    eachLine(path, (line) => {
      if (!line.includes('"result"')) return;
      let rec;
      try { rec = JSON.parse(line); } catch { return; }
      if (!isSessionResult(rec) || counted.includes(rec.session_id)) return;
      const u = rec.usage ?? {};
      cost.costUsd += rec.total_cost_usd ?? 0;
      cost.input += u.input_tokens ?? 0;
      cost.output += u.output_tokens ?? 0;
      cost.cacheRead += u.cache_read_input_tokens ?? 0;
      cost.cacheCreate += u.cache_creation_input_tokens ?? 0;
      cost.sessions += 1;
      if (typeof rec.session_id === 'string') cost.sessionIds.push(rec.session_id);
    });
  } catch {
    return null;
  }
  return cost.sessions ? cost : null;
}
