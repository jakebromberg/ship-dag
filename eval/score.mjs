#!/usr/bin/env node
// score.mjs (CLI) — offline scorer: harness raw output → scorecard → persisted result.
//
// The Workflow harness (harness.js) returns raw JSON; feed it here to compute the
// scorecard and persist it (never overwriting a prior runId). This is plain Node
// with no agent/network calls, so it runs anywhere and is cheap to re-run.
//
//   node eval/harness-output.json | node eval/score.mjs -        # from stdin
//   node eval/score.mjs @raw.json                                # from a file
//   node eval/score.mjs @raw.json --no-write                     # print only, don't persist
// Run tests: node --test "skills/ship-dag/eval/**/*.test.mjs"

import { readFileSync } from 'node:fs';
import { buildScorecard } from './lib/score.mjs';
import { writeResults } from './lib/results.mjs';

function readSource(src) {
  if (!src || src === '-') return readFileSync(0, 'utf8');
  if (src.startsWith('@')) return readFileSync(src.slice(1), 'utf8');
  return readFileSync(src, 'utf8');
}

function main(argv) {
  const noWrite = argv.includes('--no-write');
  const src = argv.find((a) => a !== '--no-write');
  const raw = JSON.parse(readSource(src));
  const card = buildScorecard(raw);
  process.stdout.write(`${JSON.stringify(card, null, 2)}\n`);
  for (const w of card.warnings) process.stderr.write(`warning: ${w}\n`);
  if (!noWrite) {
    const path = writeResults(card);
    process.stderr.write(`wrote ${path}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
