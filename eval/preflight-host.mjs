#!/usr/bin/env node
// preflight-host.mjs — verify the LOCAL host can build the mutant bank before
// the long, flaky baseline-green pass.
//
// Unlike the Workflow harness (which clones inside the sandbox), the bank builder
// runs on this macOS host and shells out to authenticated `gh`, `git`, and each
// language's toolchain. `probe.js` only checks the Workflow budget/log globals —
// it does NOT cover any of this. This preflight enumerates what's present and
// prints a per-repo gatable/parse-only verdict, implementing the "detect, then
// decide" policy: a repo whose toolchain is missing is demoted to parse-only
// (logged, not aborted); Swift is promoted to gatable iff xcodebuild is present.
//
// Usage: node eval/preflight-host.mjs
// Run tests: node --test "skills/ship-dag/eval/**/*.test.mjs"

import { execFileSync } from 'node:child_process';
import { REPO_TESTS } from './repo-tests.mjs';

// The executables each language's suite needs on PATH. Kept minimal and pure so
// resolveGatable() is unit-testable without touching the host.
export const TOOLCHAIN = {
  python: ['python3'],
  ts: ['node', 'npm'],
  rust: ['cargo'],
  swift: ['xcodebuild'],
};

/** Executables required to gate a repo of this language. */
export function requiredTools(lang) {
  return TOOLCHAIN[lang] || [];
}

/**
 * Decide a repo's EFFECTIVE gatability given which tools are actually present.
 * Pure: `presentTools` is a Set of executable names found on PATH.
 * - demoted: intended-gatable but toolchain missing → falls to parse-only.
 * - promoted: intended parse-only (Swift) but toolchain present → can gate.
 * @returns {{gatable: boolean, promoted: boolean, demoted: boolean, required: string[]}}
 */
export function resolveGatable(cfg, presentTools) {
  const required = requiredTools(cfg.lang);
  const haveAll = required.length > 0 && required.every((t) => presentTools.has(t));
  return {
    gatable: haveAll,
    promoted: haveAll && !cfg.runsLocally,
    demoted: !haveAll && cfg.runsLocally,
    required,
  };
}

// --- CLI (host-touching) ---------------------------------------------------

function onPath(exe) {
  try {
    execFileSync('command', ['-v', exe], { stdio: 'ignore', shell: '/bin/zsh' });
    return true;
  } catch {
    try {
      execFileSync('which', [exe], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

function ghAuthed() {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const present = new Set();
  for (const exe of ['git', 'gh', ...new Set(Object.values(TOOLCHAIN).flat())]) {
    if (onPath(exe)) present.add(exe);
  }
  const gh = present.has('gh') && ghAuthed();
  const lines = [];
  lines.push(`git:  ${present.has('git') ? 'ok' : 'MISSING'}`);
  lines.push(`gh:   ${present.has('gh') ? (gh ? 'ok (authed)' : 'present but NOT authed — private repos will fail') : 'MISSING'}`);
  let gatable = 0;
  for (const [repo, cfg] of Object.entries(REPO_TESTS)) {
    const r = resolveGatable(cfg, present);
    if (r.gatable) gatable += 1;
    const tag = r.gatable ? 'GATABLE' : 'parse-only';
    const why = r.demoted ? ` (demoted — missing ${r.required.filter((t) => !present.has(t)).join(', ')})` : r.promoted ? ' (promoted — xcodebuild present)' : '';
    lines.push(`${repo} [${cfg.lang}]: ${tag}${why}`);
  }
  lines.push(`\n${gatable}/${Object.keys(REPO_TESTS).length} repos test-gatable on this host; the rest fall to parse-only.`);
  const ready = present.has('git') && gh;
  process.stdout.write(`${lines.join('\n')}\n\nhost ${ready ? 'READY' : 'NOT READY (fix git/gh above before building the bank)'}\n`);
  process.exit(ready ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
