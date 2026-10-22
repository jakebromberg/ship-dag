// remote.mjs — where the board reads a ticket's engine files when a remote host builds it.
//
// A `--by-host` wave keeps each host's config at `<wave dir>/hosts/config.<host>.json`, but the remote engine writes
// its status and metadata files on the host. While host-run waits it copies them into the host's local collected dir
// (`<wave dir><letter>`, beside the wave dir: `waveDirOf`) and records which host they came from and when in
// `MIRROR_FILE` (lib/host-run.mjs). This module finds that dir, so `deriveStage` reads it as it reads a local one.

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { MIRROR_FILE } from '../lib/host-run.mjs';
import { waveDirOf } from '../lib/wave-reports.mjs';

/** The remote host a wave config sends its tickets to (`hosts/config.<host>.json`), or null for a local one. */
export function configHost(configFile) {
  const host = /^config\.(.+)\.json$/.exec(basename(configFile))?.[1];
  return host && host !== 'local' && basename(dirname(configFile)) === 'hosts' ? host : null;
}

const readMirror = (dir) => { try { return JSON.parse(readFileSync(join(dir, MIRROR_FILE), 'utf8')); } catch { return null; } };

/**
 * Where `wave`'s tickets' engine files are read when a remote host runs them: null for a local wave; else `{host}`
 * plus, once host-run has written a mirror record for that host in a family dir beside the wave dir, `dir` (that
 * collected dir), `readAt` (the last copy, an ISO string or null) and `unreachable` (the latest copy failed). An
 * unreachable host's files are stale, so a caller reads the wave dir instead and the ticket stays queued.
 * @param {{dir: string, configFile: string}} wave  a `runWaves` wave
 * @param {string[]} dirs  the run family (`runFamilyStateDirs`)
 * @returns {{host: string, dir?: string, readAt?: string|null, unreachable?: boolean}|null}
 */
export function remoteSource(wave, dirs) {
  const host = configHost(wave.configFile);
  if (!host) return null;
  for (const dir of dirs) {
    if (waveDirOf(dir) !== wave.dir) continue;
    const mirror = readMirror(dir);
    if (mirror?.host === host) return { host, dir, readAt: mirror.readAt ?? null, unreachable: Boolean(mirror.unreachableAt) };
  }
  return { host };
}
