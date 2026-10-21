// hosts.mjs — load and validate references/hosts.json, the registry of hosts other than this machine that can run a
// whole engine for a ready-wave. `local` is implicit and never listed. split-by-host.mjs reads it; emit-config.mjs
// --by-host writes one config per host.
import { readFileSync } from 'node:fs';

const HOSTS = new URL('../../references/hosts.json', import.meta.url);
export const TOOLCHAINS = ['node', 'python', 'xcode'];

/** Throw unless `hosts` is a well-formed registry map; returns it with each entry's `toolchains` defaulted to none. */
export function validateHosts(hosts) {
  const bad = (name, msg) => {
    throw new Error(`hosts.json: ${name}: ${msg}`);
  };
  if (Object.hasOwn(hosts, 'local')) bad('local', 'is implicit; do not list it');
  return Object.fromEntries(Object.entries(hosts).map(([name, h]) => {
    if (h === null || typeof h !== 'object') bad(name, 'must be an object');
    for (const k of ['ssh', 'home', 'reposDir', 'sdHome']) if (typeof h[k] !== 'string' || h[k] === '') bad(name, `${k} must be a non-empty string`);
    if (h.coHome !== undefined && typeof h.coHome !== 'string') bad(name, 'coHome must be a string');
    for (const k of ['sessionSlots', 'leaseSlots']) if (h[k] !== undefined && !(Number.isInteger(h[k]) && h[k] > 0)) bad(name, `${k} must be a positive integer`);
    const toolchains = h.toolchains ?? [];
    if (!Array.isArray(toolchains) || !toolchains.every((t) => TOOLCHAINS.includes(t))) bad(name, `toolchains must be an array of ${TOOLCHAINS.join('/')}`);
    return [name, { ...h, toolchains }];
  }));
}

/** Read and validate the registry's `hosts` map (from `path`, default the shipped file). */
export function loadHosts(path = HOSTS) {
  return validateHosts(JSON.parse(readFileSync(path, 'utf8')).hosts ?? {});
}
