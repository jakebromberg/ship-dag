// run.mjs — CLI: the ETA of a ship-dag run.
//
//   node scripts/eta/run.mjs [--run <runId>] [--state-base <dir>] [--json]
//
// Reads the run's state dirs read-only, asks GitHub for every ticket's live state and merge time in one batched
// GraphQL query, and prints model.mjs's estimate (state.mjs gathers the inputs). Without gh it falls back to the
// fetched DAG's open set and says so. Progress goes to stderr. Exit 0 printed, 1 no run or no DAG, 64 usage.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { defaultBaseDir } from '../rate-limit-preflight.mjs';
import { isMain } from '../lib/is-main.mjs';
import { ghCli, withBackoff } from '../lib/gh.mjs';
import { formatPacific, renderText } from './model.mjs';
import { computeEta } from './state.mjs';

/** The `io` state.mjs reads through, over the local file system. */
export const fsIo = {
  list: async (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch {
      return [];
    }
  },
  read: async (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  mtime: async (path) => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  },
};

/** The default `gh`: the CLI, retrying a rate-limited answer with backoff rather than reading it as gh unavailable. */
const ghRetrying = (args) => withBackoff(() => ghCli(args), { repo: 'the ETA query' });

const USAGE = 'usage: node scripts/eta/run.mjs [--run <runId>] [--state-base <dir>] [--json]';

/**
 * The CLI. Every effect is injected, so tests run it without GitHub or a real state dir.
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, { env = process.env, now = Date.now(), gh = ghRetrying, io = fsIo, stdout = console.log, stderr = console.error } = {}) {
  let args;
  try {
    args = parseArgs({ args: argv, options: { run: { type: 'string' }, 'state-base': { type: 'string' }, json: { type: 'boolean' } } }).values;
  } catch (err) {
    stderr(`eta: ${err.message}\n${USAGE}`);
    return 64;
  }
  const base = args['state-base'] ?? defaultBaseDir(env);
  const result = await computeEta({ io, gh, base, runId: args.run, now, warn: (m) => stderr(`eta: ${m}`) });
  if (result.error) {
    stderr(`eta: ${result.error}; pass --run <runId> or --state-base <dir>`);
    return 1;
  }
  if (args.json) {
    const etaPacific = Object.fromEntries(Object.entries(result.eta).map(([k, v]) => [k, formatPacific(v)]));
    stdout(JSON.stringify({ ...result, etaPacific, asOfPacific: formatPacific(now) }, null, 2));
  } else {
    stdout(renderText(result));
  }
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
