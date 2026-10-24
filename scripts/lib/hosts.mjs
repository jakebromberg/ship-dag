// hosts.mjs — load and validate hosts.json, the registry of hosts other than this machine that can run a whole engine
// for a ready-wave. `local` is implicit and never listed. split-by-host.mjs reads it; emit-config.mjs --by-host writes
// one config per host. The registry names machines and their paths, so it lives outside the repo (see hostsPath);
// references/hosts.example.json shows its shape.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const TOOLCHAINS = ['node', 'python', 'xcode'];

/** Throw unless `hosts` is a well-formed registry map; returns it with each entry's `toolchains` defaulted to none and `coHome` to `<home>/Developer/claude-orchestrator`, as CO_HOME defaults on the main Mac. */
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
    return [name, { ...h, coHome: h.coHome ?? `${h.home}/Developer/claude-orchestrator`, toolchains }];
  }));
}

/** Where the registry lives: `$SHIP_DAG_HOSTS`, else `$XDG_CONFIG_HOME/ship-dag/hosts.json`, else `<home>/.config/ship-dag/hosts.json`. An empty variable counts as unset. */
export function hostsPath(env = process.env, home = homedir()) {
  if (env.SHIP_DAG_HOSTS) return env.SHIP_DAG_HOSTS;
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'ship-dag', 'hosts.json');
}

/** Read and validate the registry's `hosts` map from `path` (default `hostsPath()`); a missing file is no remote hosts. */
export function loadHosts(path = hostsPath()) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  return validateHosts(JSON.parse(text).hosts ?? {});
}
