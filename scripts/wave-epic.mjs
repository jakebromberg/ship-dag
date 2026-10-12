#!/usr/bin/env node
// wave-epic.mjs — open, close and sweep the sub-epics that group an epic run's waves.
//
// Logic and its rules live in scripts/lib/wave-epic.mjs. This file only parses
// arguments and prints JSON.
//
// Usage:
//   node wave-epic.mjs open  --repo owner/repo --epic N --refs ref,ref,...
//   node wave-epic.mjs close --repo owner/repo --epic N --wave-epic M [--outcomes <json|@file|->]
//   node wave-epic.mjs sweep --repo owner/repo --epic N [--except M] [--dry-run]
// `open` prints { number, wave, moved[], listed[], reused }. `close` prints
// { closed, returned[], stuck[], noop }. `sweep` prints
// { closed[], returned[], stuck[], errors[] }.
// Exit 0: done. Exit 1: a return got stuck (the wave is left open on purpose),
// a swept wave failed, or a GitHub call failed partway — every command is
// idempotent, so run it again. Exit 2: a malformed invocation or a refusal,
// before any write. `--dry-run` is accepted by `sweep` only.

import { parseArgs } from 'node:util';
import { isMain } from './lib/is-main.mjs';
import { readArg } from './lib/read-arg.mjs';
import { realRunGh } from './lib/sub-issues.mjs';
import { openWaveEpic, closeWaveEpic, sweepWaveEpics, WaveEpicRefusal } from './lib/wave-epic.mjs';

const USAGE = 'usage: wave-epic.mjs open --repo owner/repo --epic N --refs ref,ref,...\n'
  + '       wave-epic.mjs close --repo owner/repo --epic N --wave-epic M [--outcomes <json|@file|->]\n'
  + '       wave-epic.mjs sweep --repo owner/repo --epic N [--except M] [--dry-run]\n';

const OPTIONS = {
  open: { repo: { type: 'string' }, epic: { type: 'string' }, refs: { type: 'string' } },
  close: { repo: { type: 'string' }, epic: { type: 'string' }, 'wave-epic': { type: 'string' }, outcomes: { type: 'string' } },
  sweep: { repo: { type: 'string' }, epic: { type: 'string' }, except: { type: 'string' }, 'dry-run': { type: 'boolean' } },
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
    } else if (cmd === 'sweep') {
      if (o.except !== undefined && !/^\d+$/.test(o.except)) exit(2);
      out = sweepWaveEpics({ repo: o.repo, epic, except: o.except && Number(o.except), dryRun: Boolean(o['dry-run']) }, realRunGh);
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
  if ((out.stuck && out.stuck.length) || (out.errors && out.errors.length)) process.exit(1);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
