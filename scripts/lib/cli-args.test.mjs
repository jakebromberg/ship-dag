// cli-args.test.mjs — shared flag parsing for the preflight CLIs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNumberOption, stringOption } from './cli-args.mjs';

const NUMBER_CASES = [
  ['a number in range', 'threshold', '0.5', { min: 0, max: 1 }, 0.5],
  ['a number at the lower bound', 'parallel', '1', { min: 1 }, 1],
  ['a missing value', 'threshold', undefined, {}, /--threshold requires a value/],
  ['a blank value', 'threshold', '  ', { min: 0, max: 1 }, /--threshold requires a value/],
  ['a non-number', 'threshold', 'abc', {}, /--threshold must be a number, got: "abc"/],
  ['below min', 'parallel', '0', { min: 1 }, /--parallel must be >= 1/],
  ['above max', 'threshold', '2', { max: 1 }, /--threshold must be <= 1/],
  ['at exclusiveMin', 'wait-max-minutes', '0', { exclusiveMin: 0 }, /must be a positive number/],
];

for (const [name, flag, raw, bounds, expected] of NUMBER_CASES) {
  test(`parseNumberOption: ${name}`, () => {
    if (expected instanceof RegExp) assert.throws(() => parseNumberOption(flag, raw, bounds), expected);
    else assert.equal(parseNumberOption(flag, raw, bounds), expected);
  });
}

const STRING_CASES = [
  ['a value', ['--repo', 'o/r', '--worktree', 'x'], '--repo', 'o/r'],
  ['a value at the end', ['--worktree', '/x'], '--worktree', '/x'],
  ['an absent flag', ['--worktree', '/x'], '--repo', undefined],
  ['a missing value', ['--repo'], '--repo', /--repo requires a value/],
  ['a following flag', ['--repo', '--worktree', 'x'], '--repo', /--repo requires a value/],
  ['an empty value', ['--repo', ''], '--repo', /--repo requires a value/],
];

for (const [name, argv, flag, expected] of STRING_CASES) {
  test(`stringOption: ${name}`, () => {
    if (expected instanceof RegExp) assert.throws(() => stringOption(argv, flag), expected);
    else assert.equal(stringOption(argv, flag), expected);
  });
}
