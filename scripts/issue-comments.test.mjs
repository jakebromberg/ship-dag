// Retrospectives and station decisions are often recorded as issue comments, so every copy of the
// implement prompt, and the retrospective's plan pass, has to read the comments and say which ones
// bind: the same maintainer-only rule triage uses for settled decisions (#93, #243).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docSection } from './lib/doc-pins.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
// workflow.js holds its prompts in template literals, so its backticks are escaped.
const unescaped = (src) => src.replaceAll('\\`', '`');

const copies = {
  'prompt.md step 2': read('scripts/engine/prompt.md').split('\n').find((l) => l.startsWith('2. ')),
  "SKILL.md's Implement block": docSection('### Implement (Sonnet, own worktree)'),
  "workflow.js's implementPrompt": unescaped(read('workflow.js')).split('function implementPrompt')[1].split('function reviewPathFor')[0],
  "SKILL.md's Retrospective plan pass": docSection('### Retrospective (Opus, read-only)').split('\n').find((l) => l.includes('For the plan pass')),
};

const READ = /gh issue view \S+( --repo \S+)? --json title,body,labels,comments`/;
const RULE = /comments whose `authorAssociation` is `OWNER`, `MEMBER` or `COLLABORATOR` are part of the spec, and a newer one overrides the body where they conflict; other comments are context only/;

for (const [name, text] of Object.entries(copies)) {
  test(`${name} reads the issue's comments and binds only maintainer comments`, () => {
    assert.ok(text, `${name} not found; update this pin to wherever it moved`);
    assert.match(text, READ);
    assert.match(text, RULE);
    assert.doesNotMatch(text, /--json title,body,labels`/);
  });
}
