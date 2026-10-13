// cli-args.mjs — flag parsing shared by the preflight CLIs, so no CLI imports
// another CLI's module for a helper.

/**
 * Parse a `--<flag> <value>` numeric option, rejecting anything `Number()`
 * can't turn into a finite value and anything outside `[min, max]` (either
 * bound optional). A bare `Number()` coercion silently turns garbage input
 * into `NaN`, which compares false against everything downstream — an
 * `--threshold` typo like `abc` would otherwise make preflightDecision's
 * `utilization < threshold` check always false and invert a healthy window
 * into a `hitl` fork instead of erroring loudly. Guards the *other* silent
 * `Number()` trap too: `Number("")` and `Number("  ")` are `0`, not `NaN` —
 * a missing/blank value would otherwise sail through the finite check and
 * land squarely inside `--threshold`'s valid `[0, 1]` range.
 * @param {string} flag  flag name for the error message, without the leading `--`
 * @param {string|undefined} raw
 * @param {{min?: number, max?: number, exclusiveMin?: number}} [bounds]
 * @returns {number}
 */
export function parseNumberOption(flag, raw, { min, max, exclusiveMin } = {}) {
  if (raw === undefined || raw.trim() === '') throw new Error(`--${flag} requires a value`);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${flag} must be a number, got: ${JSON.stringify(raw)}`);
  if (min !== undefined && n < min) throw new Error(`--${flag} must be >= ${min}, got: ${n}`);
  if (max !== undefined && n > max) throw new Error(`--${flag} must be <= ${max}, got: ${n}`);
  if (exclusiveMin !== undefined && n <= exclusiveMin) throw new Error(`--${flag} must be a positive number, got: ${n}`);
  return n;
}

/**
 * The value following `flag` in `argv`, or `undefined` when the flag is absent.
 * Throws when the value is missing, empty, or itself a `--flag`, so
 * `--repo --worktree x` is not read as repo `--worktree`.
 * @param {string[]} argv
 * @param {string} flag  with the leading `--`
 * @returns {string|undefined}
 */
export function stringOption(argv, flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}
