// Tests for the doc-pin helper: the pins find text in SKILL.md or any references/ file, and fail when it is gone or ambiguous.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docBetween, docLine, docSection } from './doc-pins.mjs';

const SKILL = ['# Title', '', '## A', 'a body', '### A1', 'a1 body', '```', '# not a heading', '```', '## B', 'b body', ''].join('\n');

function scratch(files) {
  const root = mkdtempSync(join(tmpdir(), 'doc-pins-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

test('docSection ends at the next heading of the same or a higher level, not at a deeper one or a fenced # line', () => {
  const root = scratch({ 'SKILL.md': SKILL });
  try {
    const a = docSection('## A', root);
    assert.match(a, /a body/);
    assert.match(a, /a1 body/);
    assert.match(a, /# not a heading/);
    assert.doesNotMatch(a, /b body/);
    const a1 = docSection('### A1', root);
    assert.match(a1, /a1 body/);
    assert.doesNotMatch(a1, /b body/);
    assert.match(docSection('## B', root), /b body/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('a missing heading, a missing line and a missing marker pair throw', () => {
  const root = scratch({ 'SKILL.md': SKILL });
  try {
    assert.throws(() => docSection('## Nope', root), /no heading/);
    assert.throws(() => docLine('Nope', root), /no line/);
    assert.throws(() => docBetween('## A', 'Nope', root), /no line/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('a heading or a line found twice throws, even across files', () => {
  const root = scratch({ 'SKILL.md': SKILL, 'references/x.md': '## A\nmore\n**Bold.** one\n', 'references/deep/y.md': '**Bold.** two\n' });
  try {
    assert.throws(() => docSection('## A', root), /2 hits for heading/);
    assert.throws(() => docLine('**Bold.**', root), /2 hits for line/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('docBetween returns the lines from the first marker up to the second', () => {
  const root = scratch({ 'SKILL.md': '**b.** one\ntwo\n**c.** three\n' });
  try {
    assert.equal(docBetween('**b.**', '**c.**', root), '**b.** one\ntwo');
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('moving a pinned section into references/ keeps the pins green', () => {
  const before = scratch({ 'SKILL.md': SKILL });
  const after = scratch({ 'SKILL.md': '# Title\n\n## A\na body\n### A1\na1 body\n', 'references/moved.md': '## B\nb body\n**Rule.** moved\n' });
  const bare = scratch({ 'SKILL.md': '# Title\n' });
  try {
    assert.match(docSection('## B', before), /b body/);
    assert.match(docSection('## B', after), /b body/);
    assert.equal(docLine('**Rule.**', after), '**Rule.** moved');
    assert.throws(() => docSection('## B', bare), /no heading/);
  } finally {
    rmSync(bare, { recursive: true });
    rmSync(before, { recursive: true });
    rmSync(after, { recursive: true });
  }
});

test('the real docs resolve a known section and line', () => {
  assert.match(docSection('### 5. Reconcile each result'), /Blocking finding/);
  assert.match(docLine('**Status board.**'), /board\.mjs/);
});
