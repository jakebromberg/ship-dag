// Tests for the mutation-validity (test-failure) gate classifier.
// Run: node --test "skills/ship-dag/eval/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGate, GATED, PARSE_ONLY } from './gate.mjs';

const green = { ran: true, passed: true };
const red = { ran: true, passed: false };
const didNotRun = { ran: false, passed: false };

const cases = [
  // --- test-gatable repo (runsLocally): the suite is the oracle ---
  [
    'baseline green + mutant fails a test → gated-failed (the strong label)',
    { runsLocally: true, baseline: green, mutated: red, parses: true },
    { testStatus: 'gated-failed', valid: true, bucket: GATED },
  ],
  [
    'baseline green + suite still green → gated-survived (equivalent/uncovered, dropped)',
    { runsLocally: true, baseline: green, mutated: green, parses: true },
    { testStatus: 'gated-survived', valid: false, bucket: null },
  ],
  [
    'baseline red → excluded (environment untrustworthy)',
    { runsLocally: true, baseline: red, mutated: red, parses: true },
    { testStatus: 'baseline-red', valid: false, bucket: null },
  ],
  [
    'baseline suite never ran (deps failed) → setup-failed, excluded',
    { runsLocally: true, baseline: didNotRun, mutated: didNotRun, parses: true },
    { testStatus: 'setup-failed', valid: false, bucket: null },
  ],
  [
    'baseline green but mutated run flaked out → setup-failed, not counted as a catch',
    { runsLocally: true, baseline: green, mutated: didNotRun, parses: true },
    { testStatus: 'setup-failed', valid: false, bucket: null },
  ],
  [
    'a runsLocally repo with no baseline attempted at all → setup-failed',
    { runsLocally: true, baseline: null, mutated: null, parses: true },
    { testStatus: 'setup-failed', valid: false, bucket: null },
  ],
  // --- non-gatable repo (Swift/SQL, no toolchain): parse-only fallback ---
  [
    'not gatable + still parses → parse-only (valid, weaker bucket)',
    { runsLocally: false, parses: true },
    { testStatus: 'parse-only', valid: true, bucket: PARSE_ONLY },
  ],
  [
    'not gatable + mutation broke syntax → unparseable, dropped',
    { runsLocally: false, parses: false },
    { testStatus: 'unparseable', valid: false, bucket: null },
  ],
];

for (const [name, input, expected] of cases) {
  test(`classifyGate: ${name}`, () => {
    assert.deepEqual(classifyGate(input), expected);
  });
}

test('classifyGate: gated result never lands in the parse-only bucket', () => {
  const r = classifyGate({ runsLocally: true, baseline: green, mutated: red, parses: true });
  assert.equal(r.bucket, GATED);
  assert.notEqual(r.bucket, PARSE_ONLY);
});

test('classifyGate: only gated-failed and parse-only are valid', () => {
  const all = [
    classifyGate({ runsLocally: true, baseline: green, mutated: red, parses: true }),
    classifyGate({ runsLocally: true, baseline: green, mutated: green, parses: true }),
    classifyGate({ runsLocally: true, baseline: red, mutated: red, parses: true }),
    classifyGate({ runsLocally: false, parses: true }),
    classifyGate({ runsLocally: false, parses: false }),
  ];
  const valid = all.filter((r) => r.valid).map((r) => r.testStatus).sort();
  assert.deepEqual(valid, ['gated-failed', 'parse-only']);
});
