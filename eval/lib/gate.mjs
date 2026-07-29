// gate.mjs — the mutation-validity (test-failure) gate.
//
// A seeded mutant only counts toward review recall if it is a GENUINE,
// detectable defect. The oracle is the repo's own test suite: a mutant that
// makes a passing suite fail is a real defect a competent reviewer should catch;
// a mutant that leaves the suite green is equivalent or merely uncovered — not a
// review "miss" — and must be dropped, or the recall track measures noise (this
// is the pilot's headline caveat).
//
// This is the PURE decision: it takes already-collected suite outcomes and
// returns the mutant's status. Running the suites (git clone, dep install, the
// baseline-green precondition) lives in build-mutant-bank.mjs; keeping the
// classification here makes the ground-truth rule unit-testable in isolation.
//
// Run tests: node --test "skills/ship-dag/eval/**/*.test.mjs"

// The two buckets a valid mutant can land in. `gated` is the rigorous headline
// track (a test actually failed); `parse-only` is the weaker fallback for repos
// whose suite can't run on the eval host (Swift without Xcode, PLpgSQL without a
// DB) — kept, but reported separately so it never dilutes the gated number.
export const GATED = 'gated';
export const PARSE_ONLY = 'parse-only';

/**
 * A single suite run's outcome.
 * @typedef {{ran: boolean, passed: boolean}} SuiteOutcome
 */

/**
 * Classify one mutant from its baseline/post-mutant suite outcomes.
 *
 * @param {object} o
 * @param {boolean} o.runsLocally  Is this repo INTENDED to be test-gated? (from
 *   repo-tests.mjs, narrowed by the host preflight). When false we never had an
 *   oracle, so we fall back to the parse-only check.
 * @param {SuiteOutcome|null} [o.baseline]  Suite outcome at mergeSha, pre-mutation.
 * @param {SuiteOutcome|null} [o.mutated]   Suite outcome after applying the mutant.
 * @param {boolean} o.parses  Did the mutated source still parse/compile? (the
 *   weaker check; only consulted on the non-gatable path).
 * @returns {{testStatus: string, valid: boolean, bucket: (GATED|PARSE_ONLY|null)}}
 */
export function classifyGate({ runsLocally, baseline = null, mutated = null, parses = false }) {
  if (!runsLocally) {
    // No suite oracle by design: keep the mutant only if it still parses.
    return parses
      ? { testStatus: PARSE_ONLY, valid: true, bucket: PARSE_ONLY }
      : { testStatus: 'unparseable', valid: false, bucket: null };
  }
  // Gatable repo: we EXPECTED the suite to be the oracle. If setup/baseline is
  // untrustworthy we exclude rather than silently downgrade to parse-only —
  // a broken environment must be surfaced, not counted.
  if (!baseline || !baseline.ran) return { testStatus: 'setup-failed', valid: false, bucket: null };
  if (!baseline.passed) return { testStatus: 'baseline-red', valid: false, bucket: null };
  if (!mutated || !mutated.ran) return { testStatus: 'setup-failed', valid: false, bucket: null };
  // Baseline was green: the mutation is the only change, so a now-failing suite
  // pins the defect. A still-green suite means equivalent/uncovered → drop.
  return mutated.passed
    ? { testStatus: 'gated-survived', valid: false, bucket: null }
    : { testStatus: 'gated-failed', valid: true, bucket: GATED };
}
