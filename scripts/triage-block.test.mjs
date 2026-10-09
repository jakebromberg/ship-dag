// The Triage block is pasted verbatim into subagent prompts, so its trust rule
// for comments has to live in the block itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const skill = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'SKILL.md'), 'utf8');
const block = skill.split('### Triage (Haiku, read-only)')[1].split(/\n### |\n## /)[0];
const step = (n) => block.split('\n').find((l) => l.startsWith(`> ${n}. `));

test('triage step 1 says comments carry authorAssociation and others are context only', () => {
  assert.match(step(1), /authorAssociation/);
  assert.match(step(1), /context only/);
});

test('triage step 6 counts only OWNER, MEMBER and COLLABORATOR comments as decisions', () => {
  for (const v of ['authorAssociation', 'OWNER', 'MEMBER', 'COLLABORATOR']) assert.match(step(6), new RegExp(v));
});
