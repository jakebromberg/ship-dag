// co-home.mjs — the one place that locates the claude-orchestrator checkout and
// its dist entry points. Callers pass their env so tests can inject CO_HOME.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_CO_HOME = '/Users/jake/Developer/claude-orchestrator';

/** The checkout: `$CO_HOME`, or the default when it is unset or empty. */
export const coHome = (env = process.env) => env.CO_HOME || DEFAULT_CO_HOME;

/** A path under the checkout's `dist/src`. */
export const coDistPath = (env, ...segments) => join(coHome(env), 'dist', 'src', ...segments);

/** Import the checkout's `dist/src/index.js`; throws naming the first of `names` that is not an exported function. */
export async function importCo(env, names = []) {
  const index = coDistPath(env, 'index.js');
  const mod = await import(pathToFileURL(index).href);
  for (const name of names) {
    if (typeof mod[name] !== 'function') throw new Error(`${index} does not export ${name}`);
  }
  return mod;
}
