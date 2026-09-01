#!/usr/bin/env node
// retro-pick.mjs — pull ONE retrospective proposal out of the pass's result
// file, by id, at point D.
//
// The step-6.5 Retrospective returns a structurally large object:
// `refactors[]` each carry a drafted `/file-ticket` body, and
// `planAdjustments[]` carry replacement spec text. Returned inline, all of it
// lands in main-session context and stays there — and most of it is about
// proposals the human is going to decline. So the pass writes the full object
// to `$STATE/retro/wave-<W>.json` and returns everything EXCEPT the drafted
// bodies, which is all point D's grilling needs to render its checkboxes.
//
// This script fetches the rest, one approved proposal at a time. Nothing reads
// the bodies of declined proposals, which is the majority of them.
//
// Usage:
//   node retro-pick.mjs <retro.json> <id>
// Prints that proposal as JSON on stdout. Exit 2 on a malformed invocation,
// 3 when the file or the id can't be resolved.

import { readFileSync } from 'node:fs';
import { isMain } from './lib/is-main.mjs';

/**
 * Every proposal in a retrospective envelope, refactors and plan adjustments
 * alike, tagged with which list it came from. Order is stable: refactors then
 * adjustments, each in the order the subagent ranked them.
 *
 * The tag is `list`, NOT `kind`: `planAdjustments[]` items carry their own
 * `kind` (`respec | add-edge | drop-edge | obsolete | split`), which drives
 * what point D actually does with an approved proposal. Tagging with `kind`
 * would overwrite it and turn every approved adjustment into a refactor.
 * @param {{refactors?: object[], planAdjustments?: object[]}} retro
 */
export function proposals(retro) {
  const refactors = Array.isArray(retro?.refactors) ? retro.refactors : [];
  const adjustments = Array.isArray(retro?.planAdjustments) ? retro.planAdjustments : [];
  return [
    ...refactors.map((p) => ({ list: 'refactor', ...p })),
    ...adjustments.map((p) => ({ list: 'planAdjustment', ...p })),
  ];
}

/**
 * One proposal by `id`. Throws naming every known id when it doesn't resolve —
 * a mistyped id must not silently file the wrong ticket, and the id list is
 * short enough to be the whole error message.
 * @param {object} retro
 * @param {string} id
 */
export function pick(retro, id) {
  const all = proposals(retro);
  const hit = all.find((p) => p.id === id);
  if (!hit) {
    const known = all.map((p) => p.id).filter(Boolean).join(', ') || '(none — the pass proposed nothing)';
    throw new Error(`no proposal with id ${JSON.stringify(id)}; this pass carries: ${known}`);
  }
  return hit;
}

function main(argv) {
  const [path, id] = argv.filter((a) => !a.startsWith('--'));
  if (!path || !id) {
    process.stderr.write('usage: retro-pick.mjs <retro.json> <id>\n');
    process.exit(2);
  }
  let out;
  try {
    out = pick(JSON.parse(readFileSync(path, 'utf8')), id);
  } catch (err) {
    process.stderr.write(`retro-pick: ${err.message}\n`);
    process.exit(3);
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
