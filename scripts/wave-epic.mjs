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
// { closed, returned[], stuck[], noop } and exits 1 when a return got stuck
// (the wave is left open). Exit 2 on a malformed invocation or a refusal.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isMain } from './lib/is-main.mjs';
import { openWaveEpic, closeWaveEpic } from './lib/wave-epic.mjs';

const USAGE = 'usage: wave-epic.mjs open --repo owner/repo --epic N --refs ref,ref,...\n'
  + '       wave-epic.mjs close --repo owner/repo --epic N --wave-epic M [--outcomes <json|@file|->]\n';

const runGh = (args) => execFileSync('gh', args, { encoding: 'utf8' });

function readArg(src) {
  if (src === '-') return readFileSync(0, 'utf8');
  if (src.startsWith('@')) return readFileSync(src.slice(1), 'utf8');
  return src;
}

function parse(rest) {
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || rest[i + 1] === undefined) return null;
    opts[rest[i].slice(2)] = rest[i + 1];
  }
  return opts;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const o = parse(rest);
  const fail = (msg) => { process.stderr.write(msg ? `wave-epic: ${msg}\n` : USAGE); process.exit(2); };
  if (!o || !/^[\w.-]+\/[\w.-]+$/.test(o.repo || '') || !/^\d+$/.test(o.epic || '')) fail();
  const epic = Number(o.epic);
  let out;
  try {
    if (cmd === 'open') {
      if (!o.refs) fail();
      out = openWaveEpic({ repo: o.repo, epic, refs: o.refs.split(',').filter(Boolean) }, runGh);
    } else if (cmd === 'close') {
      if (!/^\d+$/.test(o['wave-epic'] || '')) fail();
      const outcomes = o.outcomes ? JSON.parse(readArg(o.outcomes)) : {};
      out = closeWaveEpic({ repo: o.repo, epic, waveEpic: Number(o['wave-epic']), outcomes }, runGh);
    } else {
      fail();
    }
  } catch (err) {
    fail(err.message);
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (out.stuck && out.stuck.length) process.exit(1);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
