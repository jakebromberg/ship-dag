#!/usr/bin/env node
// wave-spec.mjs — narrow a ready-wave spec to the refs an engine stop left unstarted.
//
// The engine's `prepareIssues` skips only `succeeded` rows, so re-running a wave's own config would relaunch
// its `failed` rows into their existing branches, and `runSpecific` matches bare issue numbers, so it cannot
// narrow a cross-repo config. A clean stopped row is therefore re-run on a config emitted from a spec holding
// only its ref, in its own state dir (SKILL.md step 5).
//
// Usage: node wave-spec.mjs <spec.json|-> [--wave <label>] [--state-dir <dir>] <owner/repo#N>...
// Prints the filtered spec on stdout; `--wave` and `--state-dir` replace the spec's own.

import { readFileSync } from 'node:fs';
import { isMain } from './is-main.mjs';
import { formatRef } from './ref.mjs';

/**
 * `spec` with only the issues named by `refs`, in the spec's order, and `overrides` (`wave`, `stateDir`) applied.
 * An issue's ref is `repo#number`, its repo defaulting to the spec's, as emit-config reads it.
 * @throws when a ref names no issue of the spec
 */
export function filterSpec(spec, refs, overrides = {}) {
  const refOf = (i) => formatRef(i.repo || spec.repo, i.number);
  const unknown = refs.filter((r) => !spec.issues.some((i) => refOf(i) === r));
  if (unknown.length) throw new Error(`not in the spec: ${unknown.join(', ')}`);
  return { ...spec, ...overrides, issues: spec.issues.filter((i) => refs.includes(refOf(i))) };
}

function main(argv) {
  const overrides = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--wave') overrides.wave = argv[++i];
    else if (argv[i] === '--state-dir') overrides.stateDir = argv[++i];
    else positional.push(argv[i]);
  }
  const [file, ...refs] = positional;
  if (!file || !refs.length) {
    console.error('Usage: wave-spec.mjs <spec.json|-> [--wave <label>] [--state-dir <dir>] <owner/repo#N>...');
    process.exit(2);
  }
  try {
    process.stdout.write(`${JSON.stringify(filterSpec(JSON.parse(readFileSync(file === '-' ? 0 : file, 'utf8')), refs, overrides), null, 2)}\n`);
  } catch (err) {
    console.error(`wave-spec: ${err.message}`);
    process.exit(2);
  }
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
