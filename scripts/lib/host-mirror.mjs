// host-mirror.mjs — the record host-run keeps in a remote host's local collected dir of which host its `state/` was
// copied from and when, and the one reader and writer of it: host-run writes it, the status board (board/remote.mjs)
// reads it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './write-atomic.mjs';

/** The record's file name, in the local collected dir. */
export const MIRROR_FILE = 'host-mirror.json';

/**
 * The record after a copy at `at` (an ISO string) from host `name` that succeeded (`ok`) or failed: `{host, readAt}`,
 * the last successful copy (null before any), plus `unreachableAt` when the latest copy failed. `prev` is the record
 * before it, or null; a record of another host's is not carried over.
 */
export function mirrorRecord(prev, name, ok, at) {
  if (ok) return { host: name, readAt: at };
  return { host: name, readAt: prev?.host === name ? prev.readAt ?? null : null, unreachableAt: at };
}

/** The record in `dir`, or null when it is absent or does not parse. */
export function readMirror(dir) {
  try { return JSON.parse(readFileSync(join(dir, MIRROR_FILE), 'utf8')); } catch { return null; }
}

/** Merge a copy's outcome into the record in `dir` (`mirrorRecord`) and write it atomically, so a board refresh never reads it half written. */
export function writeMirror(dir, name, ok, at) {
  writeAtomic(join(dir, MIRROR_FILE), `${JSON.stringify(mirrorRecord(readMirror(dir), name, ok, at))}\n`);
}
