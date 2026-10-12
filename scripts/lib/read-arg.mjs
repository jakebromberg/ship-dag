// read-arg.mjs — the `<json|@file|->` convention the CLIs share for JSON flags.

import { readFileSync } from 'node:fs';

/** `-` reads stdin, `@path` reads that file, anything else is the value itself. */
export function readArg(src) {
  if (src === '-') return readFileSync(0, 'utf8');
  if (src.startsWith('@')) return readFileSync(src.slice(1), 'utf8');
  return src;
}
