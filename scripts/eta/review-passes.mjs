// review-passes.mjs — when each ticket's PR last passed review, for the ETA's depth latency.
//
//   node scripts/eta/review-passes.mjs --run <runId> --refs <ref,ref,...> [--state-base <dir>]
//
// A pass is the latest review round for the ref, across the run family's `reviews/` dirs, that the gate does not
// read as blocking; its time is the round file's mtime (a review file carries no timestamp of its own). Rounds come
// from the shared matcher (`reviewRoundFiles`) and each verdict from the gate itself (`classifyRound` over
// `gateReview`), under the `blockOn` of the ref's own wave from the run's sidecar, so the ETA can never disagree
// with the merge gate about what passed. The CLI prints `{ref: epochMs}` as JSON for a host that cannot import this module (the
// mod, which runs it through node). Exit 0 printed, 1 state it could not read, 64 usage.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultBaseDir } from '../rate-limit-preflight.mjs';
import { DEFAULT_BLOCK_ON } from '../review-gate.mjs';
import { isMain } from '../lib/is-main.mjs';
import { classifyRound, reviewRoundFiles } from '../lib/review-rounds.mjs';
import { runFamilyStateDirs } from '../lib/wave-reports.mjs';
import { SIDECAR_NAME, readSidecar } from '../lib/wave-sidecar.mjs';

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Each ref's `blockOn`: that of the newest wave sidecar entry across the family that lists the ref and names one, as
 * the gate judged that ref's wave; for a ref no entry lists, the newest entry's that names one; else the gate's
 * default. Newest is by `emittedAt` (dir names do not sort by time: `-w10` sorts before `-w2`); an entry with no
 * parseable `emittedAt` is the oldest.
 * @returns {(ref: string) => string[]}
 */
function blockOnByRef(dirs, warn) {
  const when = (e) => Date.parse(e.emittedAt) || 0;
  const entries = dirs.flatMap((d) => readSidecar(join(d, SIDECAR_NAME), { warn })).filter((e) => Array.isArray(e.blockOn));
  entries.sort((a, b) => when(a) - when(b));
  const runWide = entries.at(-1)?.blockOn ?? DEFAULT_BLOCK_ON;
  return (ref) => entries.findLast((e) => (e.issues ?? []).some((i) => i?.ref === ref))?.blockOn ?? runWide;
}

/**
 * Each ref's latest passing review round time, as epoch ms; a ref with no passing round is absent.
 * @param {{runDir: string, refs: string[], warn?: (m: string) => void}} args
 * @returns {Map<string, number>}
 */
export function reviewPasses({ runDir, refs, warn = () => {} }) {
  const dirs = runFamilyStateDirs(runDir, { warn });
  const blockOnFor = blockOnByRef(dirs, warn);
  const reviewDirs = dirs.map((d) => join(d, 'reviews'));
  const passes = new Map();
  for (const ref of refs) {
    const blockOn = blockOnFor(ref);
    const pass = reviewRoundFiles(reviewDirs, ref)
      .findLast(({ path }) => classifyRound({ path, review: readJson(path) }, blockOn).verdict !== 'blocking');
    if (pass) {
      passes.set(ref, pass.mtimeMs);
    }
  }
  return passes;
}

const USAGE = 'usage: node scripts/eta/review-passes.mjs --run <runId> --refs <ref,ref,...> [--state-base <dir>]';

/** The CLI. @returns {number} the exit code */
export function main(argv, { env = process.env, stdout = console.log, stderr = console.error } = {}) {
  let args;
  try {
    args = parseArgs({ args: argv, options: { run: { type: 'string' }, refs: { type: 'string' }, 'state-base': { type: 'string' } } }).values;
  } catch (err) {
    stderr(`review-passes: ${err.message}\n${USAGE}`);
    return 64;
  }
  if (!args.run || args.refs === undefined) {
    stderr(USAGE);
    return 64;
  }
  const runDir = join(args['state-base'] ?? defaultBaseDir(env), args.run);
  const refs = args.refs.split(',').filter(Boolean);
  let passes;
  try {
    passes = reviewPasses({ runDir, refs, warn: (m) => stderr(`review-passes: ${m}`) });
  } catch (err) {
    stderr(`review-passes: cannot read ${runDir}'s review rounds (${err.message})`);
    return 1;
  }
  stdout(JSON.stringify(Object.fromEntries(passes)));
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
