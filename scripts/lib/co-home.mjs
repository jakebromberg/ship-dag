// co-home.mjs — the one place that locates the claude-orchestrator checkout and
// its dist entry points. Callers pass their env so tests can inject CO_HOME.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The checkout: `$CO_HOME`, or `<home>/Developer/claude-orchestrator` when it is unset or empty. */
export const coHome = (env = process.env, home = homedir()) => env.CO_HOME || join(home, 'Developer', 'claude-orchestrator');

/** A path under an explicit checkout `home`, joined as given (no env fallback). */
export const coDistPathIn = (home, ...segments) => join(home, 'dist', 'src', ...segments);

/** A path under the located checkout's `dist/src`. */
export const coDistPath = (env, ...segments) => coDistPathIn(coHome(env), ...segments);

/** Import the checkout's `dist/src/index.js`; throws naming the first of `names` that is not an exported function. */
export async function importCo(env, names = []) {
  const index = coDistPath(env, 'index.js');
  const mod = await import(pathToFileURL(index).href);
  for (const name of names) {
    if (typeof mod[name] !== 'function') throw new Error(`${index} does not export ${name}`);
  }
  return mod;
}
