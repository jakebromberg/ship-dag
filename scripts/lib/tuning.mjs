// tuning.mjs — load, validate and resolve references/tuning.json, the versioned
// home of ship-dag's effort policy (review floor, reach→effort, implement map).
//
// Usage: node tuning.mjs resolve <dotted.key>   # e.g. implement.normal → medium
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

export const TUNING_PATH = fileURLToPath(new URL('../../references/tuning.json', import.meta.url));
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const COMPLEXITIES = ['mechanical', 'normal', 'complex'];

/** Throw unless `t` is a well-formed version-1 tuning object; returns `t`. */
export function validate(t) {
  const bad = (msg) => {
    throw new Error(`tuning.json: ${msg}`);
  };
  if (t?.version !== 1) bad(`unsupported version ${JSON.stringify(t?.version)} (want 1)`);
  const effort = (path, v) => EFFORTS.includes(v) || bad(`${path} must be one of ${EFFORTS.join('/')}, got ${JSON.stringify(v)}`);
  const r = t.review ?? bad('missing review');
  effort('review.effortFloor', r.effortFloor);
  if (!Number.isInteger(r.passes) || r.passes < 1) bad('review.passes must be a positive integer');
  for (const k of ['serial', 'scopedRegate']) if (typeof r[k] !== 'boolean') bad(`review.${k} must be a boolean`);
  for (const k of ['in-diff', 'repo', 'external']) effort(`review.reachEffort.${k}`, r.reachEffort?.[k]);
  for (const k of COMPLEXITIES) effort(`implement.${k}`, t.implement?.[k]);
  // The keys are triage's complexity enum, which the engine schema also enforces.
  for (const k of Object.keys(t.implement)) if (!COMPLEXITIES.includes(k)) bad(`unknown implement tier ${JSON.stringify(k)}`);
  return t;
}

/** Read and validate tuning.json (from `path`, default the shipped file). */
export function load(path = TUNING_PATH) {
  return validate(JSON.parse(readFileSync(path, 'utf-8')));
}

/** The value at a dotted key, or undefined (own keys of objects only; never descends into a leaf). */
export function resolve(tuning, key) {
  return key.split('.').reduce((o, k) => (o !== null && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined), tuning);
}

if (isMain(import.meta.url)) {
  const [cmd, key] = process.argv.slice(2);
  if (cmd !== 'resolve' || !key) {
    console.error('Usage: tuning.mjs resolve <dotted.key>');
    process.exit(2);
  }
  try {
    const v = resolve(load(), key);
    if (v === undefined) throw new Error(`no such key: ${key}`);
    console.log(typeof v === 'object' ? JSON.stringify(v) : v);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
