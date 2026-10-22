// remote.mjs — where the board reads a ticket's engine files when a remote host builds it.
//
// A `--by-host` wave keeps each host's config at `<wave dir>/hosts/config.<host>.json`, but the remote engine writes
// its status and metadata files on the host. While host-run waits it copies them into the host's local collected dir
// (`<wave dir><letter>`, beside the wave dir: `waveDirOf`) and records which host they came from and when in
// `host-mirror.json` (lib/host-mirror.mjs). This module finds that dir, so `deriveStage` reads it as it reads a local one.

import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { statusPathForRef } from '../lib/failure.mjs';
import { readMirror } from '../lib/host-mirror.mjs';
import { waveDirOf } from '../lib/wave-reports.mjs';

/** The remote host a wave config sends its tickets to (`hosts/config.<host>.json`), or null for a local one. */
export function configHost(configFile) {
  const host = /^config\.(.+)\.json$/.exec(basename(configFile))?.[1];
  return host && host !== 'local' && basename(dirname(configFile)) === 'hosts' ? host : null;
}

/**
 * Where `ref`'s engine files are read when a remote host runs `wave`: null for a local wave; else `{host}` plus, once
 * host-run has written a mirror record for that host in a family dir beside the wave dir, `dir` (that collected dir),
 * `readAt` (the last copy, an ISO string or null) and `unreachable` (the latest copy failed). An unreachable host's
 * files are stale, so a caller reads the wave dir instead and the ticket stays queued. A dir beside the wave dir with
 * no record (collected by an older host-run, or its record unwritten) is still used when it holds `ref`'s status file,
 * which names the ref, so it cannot be another ticket's; its `readAt` is undefined (unknown).
 * @param {{dir: string, configFile: string}} wave  a `runWaves` wave
 * @param {string[]} dirs  the run family (`runFamilyStateDirs`)
 * @param {string} ref  composite ref
 * @returns {{host: string, dir?: string, readAt?: string|null, unreachable?: boolean}|null}
 */
export function remoteSource(wave, dirs, ref) {
  const host = configHost(wave.configFile);
  if (!host) return null;
  const beside = dirs.filter((dir) => waveDirOf(dir) === wave.dir);
  for (const dir of beside) {
    const mirror = readMirror(dir);
    if (mirror?.host === host) return { host, dir, readAt: mirror.readAt ?? null, unreachable: Boolean(mirror.unreachableAt) };
  }
  const collected = beside.find((dir) => !readMirror(dir) && existsSync(statusPathForRef(dir, ref)));
  return collected ? { host, dir: collected } : { host };
}
