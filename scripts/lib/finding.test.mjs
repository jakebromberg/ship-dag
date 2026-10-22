import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFindingObject } from './finding.mjs';

const CASES = [
  ['a full object', { category: 'security', verdict: 'CONFIRMED', summary: 's' }, true],
  ['null category and verdict', { category: null, verdict: null, summary: '' }, true],
  ['no summary', { category: 'c', verdict: null }, false],
  ['no verdict', { category: 'c', file: 'a.js', line: 1, summary: 's' }, false],
  ['a non-string category', { category: 3, verdict: null, summary: 's' }, false],
  ['a string', 'a', false],
  ['null', null, false],
  ['a number', 7, false],
];
for (const [label, value, ok] of CASES) test(`isFindingObject: ${label} is ${ok}`, () => assert.equal(isFindingObject(value), ok));
