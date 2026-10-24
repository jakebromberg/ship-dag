// SKILL.md's size ratchet and link check. SKILL.md is read whole by the orchestrator on every run, so its growth is
// capped; prose that must grow past the cap moves to references/ and is linked from SKILL.md.
// Raise SKILL_MD_BUDGET only by moving text out; each move PR sets it to the new size plus 4,096, rounded up to a multiple of 4,096.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
export const SKILL_MD_BUDGET = 139264;

const slug = (heading) => heading.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s/g, '-');

/** The `references/…` links in `text` that do not resolve under `root` to a file, or to a heading when they carry `#anchor`. */
export function unresolvedLinks(text, root) {
  const links = [...text.matchAll(/references\/[\w./-]+?\.(?:md|json)(?:#([\w-]+))?/g)];
  return links.flatMap(([link, anchor]) => {
    const file = join(root, link.split('#')[0]);
    if (!existsSync(file)) return [link];
    if (!anchor) return [];
    const headings = readFileSync(file, 'utf8').split('\n').filter((l) => /^#+ /.test(l)).map((l) => slug(l.replace(/^#+ /, '')));
    return headings.includes(anchor) ? [] : [link];
  });
}

test(`SKILL.md stays within ${SKILL_MD_BUDGET} bytes`, () => {
  const size = statSync(join(ROOT, 'SKILL.md')).size;
  assert.ok(size <= SKILL_MD_BUDGET, `SKILL.md is ${size} bytes, over the ${SKILL_MD_BUDGET} budget: move prose to references/ and lower nothing else`);
});

test('the budget is a multiple of 4,096', () => {
  assert.equal(SKILL_MD_BUDGET % 4096, 0);
});

test('every references/ link in SKILL.md resolves to a file', () => {
  assert.deepEqual(unresolvedLinks(readFileSync(join(ROOT, 'SKILL.md'), 'utf8'), ROOT), []);
});

test('a link to a missing file, or to a missing heading, is unresolved', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-size-'));
  try {
    mkdirSync(join(root, 'references'));
    writeFileSync(join(root, 'references', 'a.md'), '# A\n## Point F: the rule\n');
    const text = 'see references/a.md, references/a.md#point-f-the-rule, references/a.md#nope, references/gone.md and references/gone.json#x.';
    assert.deepEqual(unresolvedLinks(text, root), ['references/a.md#nope', 'references/gone.md', 'references/gone.json#x']);
  } finally {
    rmSync(root, { recursive: true });
  }
});
