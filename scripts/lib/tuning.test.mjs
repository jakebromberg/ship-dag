// Tests for tuning.json and its pins. Run: node --test "scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { load, validate, resolve } from './tuning.mjs';
import { VARIANTS } from '../../eval/variants.mjs';

const root = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const tuning = load();
const clone = () => structuredClone(tuning);

test('the shipped tuning.json is version 1 and holds today\'s values', () => {
  assert.equal(tuning.version, 1);
  assert.deepEqual(tuning.review, {
    effortFloor: 'high',
    passes: 1,
    serial: true,
    reachEffort: { 'in-diff': 'medium', repo: 'high', external: 'xhigh' },
    scopedRegate: false,
  });
  assert.deepEqual(tuning.implement, { mechanical: 'low', normal: 'medium', complex: 'high' });
});

test('validate rejects malformed tuning', () => {
  const cases = {
    'wrong version': (t) => (t.version = 2),
    'bad floor': (t) => (t.review.effortFloor = 'extreme'),
    'zero passes': (t) => (t.review.passes = 0),
    'non-boolean serial': (t) => (t.review.serial = 'yes'),
    'missing reach': (t) => delete t.review.reachEffort.external,
    'missing implement tier': (t) => delete t.implement.complex,
    'extra implement tier': (t) => (t.implement.trivial = 'low'),
    'missing review': (t) => delete t.review,
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const t = clone();
    mutate(t);
    assert.throws(() => validate(t), /tuning\.json/, name);
  }
});

test('resolve walks dotted keys; the CLI prints the value', () => {
  assert.equal(resolve(tuning, 'implement.normal'), 'medium');
  assert.equal(resolve(tuning, 'review.reachEffort.in-diff'), 'medium');
  assert.equal(resolve(tuning, 'nope.x'), undefined);
  for (const key of ['implement.normal.length', 'implement.normal.0']) assert.equal(resolve(tuning, key), undefined, key);
  const cli = (key) => execFileSync('node', [root('scripts/lib/tuning.mjs'), 'resolve', key], { encoding: 'utf-8' }).trim();
  assert.equal(cli('review.effortFloor'), 'high');
  assert.throws(() => cli('nope'), /Command failed/);
});

test('workflow.js implEffortFor agrees with the implement map', () => {
  const src = readFileSync(root('workflow.js'), 'utf-8');
  const m = src.match(/function implEffortFor\(iss\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'workflow.js: implEffortFor not found — update this pin');
  const fn = m[0];
  const implEffortFor = new Function(`${fn}; return implEffortFor`)();
  for (const [complexity, effort] of Object.entries(tuning.implement)) {
    assert.equal(implEffortFor({ complexity }), effort, complexity);
  }
  assert.equal(implEffortFor({}), tuning.implement.normal, 'no complexity → normal');
});

test('model-effort-matrix.md tables agree with tuning', () => {
  const md = readFileSync(root('references/model-effort-matrix.md'), 'utf-8');
  const row = (step) => {
    const line = md.split('\n').find((l) => l.startsWith(`| ${step} |`));
    assert.ok(line, `model-effort-matrix.md: no "${step}" row — update this pin`);
    return line.split('|').map((c) => c.trim());
  };
  const impl = row('Implement');
  assert.equal(impl[3], tuning.implement.normal, 'default');
  assert.match(impl[4], new RegExp(`\\*\\*${tuning.implement.complex}\\*\\*`), 'escalate');
  assert.match(impl[5], new RegExp(`\\*\\*${tuning.implement.mechanical}\\*\\*`), 'de-escalate');
  assert.equal(row('Review')[3], tuning.review.effortFloor);
  assert.match(row('Review')[5], new RegExp(`never below ${tuning.review.effortFloor}`));
});

test('eval variants.current agrees with tuning', () => {
  assert.equal(VARIANTS.current.review.effort, tuning.review.effortFloor);
  assert.equal(VARIANTS.current.implement.effort, tuning.implement.normal);
});
