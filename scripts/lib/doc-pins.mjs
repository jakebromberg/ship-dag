// doc-pins.mjs — find prose in SKILL.md and references/**/*.md wherever it lives, so a test pins the text and not the
// file it sits in. Each lookup asserts exactly one hit and throws on none or several, so a pin whose text moved away or
// was copied fails instead of silently passing. Markdown docs only; tests of workflow.js, prompt.md or the README read their own.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The docs under `root` as `{ file, lines }`: SKILL.md, then every .md under references/. */
function docs(root) {
  const dir = join(root, 'references');
  const refs = existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.md')).sort() : [];
  return ['SKILL.md', ...refs.map((f) => join('references', f))].map((file) => ({ file, lines: readFileSync(join(root, file), 'utf8').split('\n') }));
}

/** Every `{ file, lines, at }` where a line satisfies `test`; throws unless there is exactly one. */
function one(root, test, what) {
  const hits = docs(root).flatMap(({ file, lines }) => lines.flatMap((l, at) => (test(l) ? [{ file, lines, at }] : [])));
  if (hits.length !== 1) throw new Error(`doc-pins: ${hits.length === 0 ? `no ${what}` : `${hits.length} hits for ${what} (${hits.map((h) => h.file).join(', ')}); want exactly one`}`);
  return hits[0];
}

const level = (l) => /^(#+) /.exec(l)?.[1].length ?? 0;

/** The text from the one line starting with `heading` (e.g. `### 5. Reconcile`) to the next heading of the same or a higher level; a `#` line inside a code fence is not a heading. */
export function docSection(heading, root = ROOT) {
  const { lines, at } = one(root, (l) => l.startsWith(heading) && level(l) > 0, `heading starting ${JSON.stringify(heading)}`);
  const depth = level(lines[at]);
  let fenced = false;
  const end = lines.findIndex((l, i) => {
    if (i <= at) return false;
    if (l.startsWith('```')) fenced = !fenced;
    return !fenced && level(l) > 0 && level(l) <= depth;
  });
  return lines.slice(at, end < 0 ? undefined : end).join('\n');
}

/** The one line that starts with `marker`. */
export function docLine(marker, root = ROOT) {
  const { lines, at } = one(root, (l) => l.startsWith(marker), `line starting ${JSON.stringify(marker)}`);
  return lines[at];
}

/** The lines from the one starting with `start` up to, not including, the first later line starting with `end`; both lines must sit in the same file. */
export function docBetween(start, end, root = ROOT) {
  const { lines, at } = one(root, (l) => l.startsWith(start), `line starting ${JSON.stringify(start)}`);
  const stop = lines.findIndex((l, i) => i > at && l.startsWith(end));
  if (stop < 0) throw new Error(`doc-pins: no line starting ${JSON.stringify(end)} after ${JSON.stringify(start)}`);
  return lines.slice(at, stop).join('\n');
}
