#!/usr/bin/env node
// wave-epic.mjs — open and close the sub-epic for one wave of an epic run.
//
// Logic and its rules live in scripts/lib/wave-epic.mjs. This file only parses
// arguments and prints JSON.
//
// Usage:
//   node wave-epic.mjs open  --repo owner/repo --epic N --refs ref,ref,...
//   node wave-epic.mjs close --repo owner/repo --epic N --wave-epic M [--outcomes <json|@file|->]
// `open` prints { number, wave, moved[], listed[], reused }. `close` prints
// { closed, returned[], stuck[], noop }.
// Exit 0: done. Exit 1: a return got stuck (the wave is left open on purpose),
// or a GitHub call failed partway — both commands are idempotent, so run it
// again. Exit 2: a malformed invocation or a refusal, before any write.

import { parseArgs } from 'node:util';
import { isMain } from './lib/is-main.mjs';
import { readArg } from './lib/read-arg.mjs';
import { realRunGh } from './lib/sub-issues.mjs';
import { openWaveEpic, closeWaveEpic, WaveEpicRefusal } from './lib/wave-epic.mjs';

const USAGE = 'usage: wave-epic.mjs open --repo owner/repo --epic N --refs ref,ref,...\n'
  + '       wave-epic.mjs close --repo owner/repo --epic N --wave-epic M [--outcomes <json|@file|->]\n';

const OPTIONS = {
  open: { repo: { type: 'string' }, epic: { type: 'string' }, refs: { type: 'string' } },
  close: { repo: { type: 'string' }, epic: { type: 'string' }, 'wave-epic': { type: 'string' }, outcomes: { type: 'string' } },
};

function main(argv) {
  const [cmd, ...rest] = argv;
  const exit = (code, msg) => { process.stderr.write(msg ? `wave-epic: ${msg}\n` : USAGE); process.exit(code); };
  if (!OPTIONS[cmd]) exit(2);
  let o;
  try {
    o = parseArgs({ args: rest, options: OPTIONS[cmd], strict: true }).values;
  } catch (err) {
    exit(2, err.message);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo || '') || !/^\d+$/.test(o.epic || '')) exit(2);
  const epic = Number(o.epic);
  let out;
  try {
    if (cmd === 'open') {
      if (!o.refs) exit(2);
      out = openWaveEpic({ repo: o.repo, epic, refs: o.refs.split(',').filter(Boolean) }, realRunGh);
    } else {
      if (!/^\d+$/.test(o['wave-epic'] || '')) exit(2);
      let outcomes = {};
      try {
        if (o.outcomes) outcomes = JSON.parse(readArg(o.outcomes));
      } catch (err) {
        exit(2, `--outcomes: ${err.message}`);
      }
      out = closeWaveEpic({ repo: o.repo, epic, waveEpic: Number(o['wave-epic']), outcomes }, realRunGh);
    }
  } catch (err) {
    if (err instanceof WaveEpicRefusal) exit(2, err.message);
    exit(1, `${err.message} — failed partway; the command is idempotent, so run it again`);
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (out.stuck && out.stuck.length) process.exit(1);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
