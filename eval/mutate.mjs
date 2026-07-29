#!/usr/bin/env node
// mutate.mjs — language-agnostic source mutation generators for the review-recall track.
//
// The review track measures whether a review model CATCHES a seeded defect. We
// take a known-good source file, introduce exactly ONE small behavior-changing
// mutation, and hand the diff to a fresh review agent; the seeded mutation is the
// ground-truth label (caught / missed), sidestepping the circularity of using a
// model's own review as the oracle. Mutators are token-level and language-
// agnostic — they target operators/keywords common to the corpus languages
// (Python, TS, Rust, Swift, SQL) — so one implementation seeds them all.
//
// Relational/equality mutators require SPACE-flanked operators (` < `, ` == `)
// so they never corrupt arrows (`=>`, `->`), generics (`Array<T>`), or shifts;
// this trades some recall (unspaced comparisons are skipped) for only ever
// emitting syntactically safe mutants. The harness additionally verifies each
// seeded mutant still parses before scoring it (invalid ones are dropped).
//
// Pure library (generateMutants / applyMutant) + a thin CLI the sandbox invokes
// to seed a file during a harness run (keeping this the single tested source of
// truth for seeding, since workflow scripts cannot import):
//   node mutate.mjs list <file>                          # enumerate mutants (JSON)
//   node mutate.mjs apply <file> --kind K [--ordinal N]  # print the mutated source
// Run tests: node --test "skills/ship-dag/eval/**/*.test.mjs"

import { readFileSync } from 'node:fs';

// Each mutator flips a token to a behavior-changing counterpart. `re()` returns a
// FRESH /g regex per call (a stateful lastIndex must never be shared). Operator
// alternations are ordered longest-first so `<=` matches before `<`.
export const MUTATORS = [
  {
    kind: 'relational',
    re: () => /(?<= )(?:<=|>=|<|>)(?= )/g,
    flip: (m) => ({ '<': '<=', '>': '>=', '<=': '<', '>=': '>' })[m],
  },
  {
    kind: 'equality',
    re: () => /(?<= )(?:===|!==|==|!=)(?= )/g,
    flip: (m) => ({ '==': '!=', '!=': '==', '===': '!==', '!==': '===' })[m],
  },
  {
    kind: 'boolean',
    re: () => /\b(?:true|false|True|False)\b/g,
    flip: (m) => ({ true: 'false', false: 'true', True: 'False', False: 'True' })[m],
  },
  { kind: 'await', re: () => /\bawait\s+/g, flip: () => '' },
  { kind: 'off-by-one', re: () => /[+-] ?1\b/g, flip: (m) => `${m.slice(0, -1)}2` },
];

const KINDS = new Set(MUTATORS.map((m) => m.kind));

function lineColAt(source, index) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < index; i += 1) {
    if (source[i] === '\n') {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return { line, col };
}

/**
 * Enumerate single-token mutants of `source`. Each mutant records the exact
 * byte `index`, the matched `before` text, and its `after` replacement, so
 * applyMutant() can reconstruct it against the original source. `ordinal` is the
 * per-kind occurrence counter (0-based). `limitPerKind` caps occurrences and
 * records any capped kind in `truncated` — never silently dropped.
 * @param {string} source
 * @param {{kinds?: string[], limitPerKind?: number}} [opts]
 * @returns {{mutants: object[], truncated: string[]}}
 */
/**
 * Blank out comments and string/docstring literals (preserving length and
 * newlines) so operator mutators never fire inside them — a `>` in a comment or
 * a docstring is not a behavior-changing defect, and seeding one makes the
 * review-recall track measure noise. Heuristic and language-agnostic: handles
 * `//`, `--`, and whitespace-led `#` line comments, C-style block comments, and
 * single / double / backtick / triple-quoted strings across the corpus languages.
 */
export function maskNonCode(source) {
  const out = source.split('');
  const n = source.length;
  const blank = (a, b) => { for (let k = a; k < b; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  const wsBefore = (i) => i === 0 || /\s/.test(source[i - 1]);
  let i = 0;
  while (i < n) {
    const c = source[i];
    const two = source.slice(i, i + 2);
    const three = source.slice(i, i + 3);
    if (two === '//' || ((two === '--' || c === '#') && wsBefore(i))) {
      let j = i;
      while (j < n && source[j] !== '\n') j += 1;
      blank(i, j); i = j; continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const j = end === -1 ? n : end + 2;
      blank(i, j); i = j; continue;
    }
    if (three === '"""' || three === "'''") {
      const end = source.indexOf(three, i + 3);
      const j = end === -1 ? n : end + 3;
      blank(i, j); i = j; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && source[j] !== c) { if (source[j] === '\\') j += 1; j += 1; }
      j = j < n ? j + 1 : n;
      blank(i, j); i = j; continue;
    }
    i += 1;
  }
  return out.join('');
}

export function generateMutants(source, { kinds = null, limitPerKind = Infinity } = {}) {
  const masked = maskNonCode(source); // operators inside comments/strings are blanked out
  const mutants = [];
  const truncated = [];
  for (const mut of MUTATORS) {
    if (kinds && !kinds.includes(mut.kind)) continue;
    const re = mut.re();
    let m;
    let count = 0;
    while ((m = re.exec(masked)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1; // guard against a zero-width match looping forever
        continue;
      }
      if (count >= limitPerKind) {
        truncated.push(mut.kind);
        break;
      }
      // Matched against the masked copy; read the real token from the original.
      const before = source.slice(m.index, m.index + m[0].length);
      const { line, col } = lineColAt(source, m.index);
      mutants.push({
        id: `${mut.kind}:${count}`,
        kind: mut.kind,
        ordinal: count,
        line,
        col,
        index: m.index,
        before,
        after: mut.flip(before),
      });
      count += 1;
    }
  }
  return { mutants, truncated };
}

/** Apply one mutant to the ORIGINAL source it was generated from. */
export function applyMutant(source, mutant) {
  return source.slice(0, mutant.index) + mutant.after + source.slice(mutant.index + mutant.before.length);
}

function main(argv) {
  const [cmd, file, ...rest] = argv;
  if ((cmd !== 'list' && cmd !== 'apply') || !file) {
    process.stderr.write('usage: mutate.mjs <list|apply> <file> [--kind K --ordinal N]\n');
    process.exit(2);
  }
  const source = readFileSync(file, 'utf8');
  if (cmd === 'list') {
    process.stdout.write(`${JSON.stringify(generateMutants(source), null, 2)}\n`);
    return;
  }
  let kind = null;
  let ordinal = 0;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--kind') kind = rest[++i];
    else if (rest[i] === '--ordinal') ordinal = Number(rest[++i]);
  }
  if (!kind || !KINDS.has(kind)) {
    process.stderr.write(`apply requires --kind one of: ${[...KINDS].join(', ')}\n`);
    process.exit(2);
  }
  const { mutants } = generateMutants(source, { kinds: [kind] });
  const target = mutants.find((x) => x.ordinal === ordinal);
  if (!target) {
    process.stderr.write(`no '${kind}' mutant at ordinal ${ordinal} in ${file}\n`);
    process.exit(1);
  }
  process.stdout.write(applyMutant(source, target));
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
