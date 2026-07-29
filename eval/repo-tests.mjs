// repo-tests.mjs — per-repo test-suite configuration for the mutation-validity
// gate (build-mutant-bank.mjs). One entry per corpus repo.
//
// `runsLocally` is the INTENT: is this repo's suite meant to be the gate oracle
// on the eval host? Python/TS/Rust: yes. Swift needs Xcode + a simulator and
// PLpgSQL paths need a live DB, so those default to parse-only — but the host is
// macOS, so preflight-host.mjs probes for `xcodebuild` and, if present, may
// promote wxyc-ios-64 to gatable (the "detect, then decide" policy).
//
// `setup`/`test` are CANDIDATE commands, confirmed against each repo at its
// `mergeSha` when the bank is built; a command that fails to install or run
// degrades that repo/issue to parse-only (or excludes it), never a silent pass —
// see gate.mjs. Commands run inside a disposable clone and MUST NOT push.
//
// Run tests: node --test "skills/ship-dag/eval/**/*.test.mjs"

/**
 * @typedef {object} RepoTestConfig
 * @property {string}   lang         Primary language (for preflight toolchain checks).
 * @property {string[]} setup        Shell commands to install deps in the clone (in order).
 * @property {string}   test         Shell command that runs the suite (non-zero exit = fail).
 * @property {number}   timeoutSec   Hard cap per suite run.
 * @property {boolean}  runsLocally  Intended to be test-gated on the eval host.
 * @property {string}   [note]       Human note on caveats (DB, simulator, etc.).
 */

/** @type {Record<string, RepoTestConfig>} */
export const REPO_TESTS = {
  'WXYC/library-metadata-lookup': {
    lang: 'python',
    setup: [
      'python3 -m venv .venv',
      '. .venv/bin/activate && (pip install -e ".[dev]" -q || pip install -e . -q || pip install -r requirements.txt -q)',
    ],
    test: '. .venv/bin/activate && pytest -q',
    timeoutSec: 600,
    runsLocally: true,
  },
  'WXYC/dj-site': {
    lang: 'ts',
    setup: ['npm ci --no-audit --no-fund || npm install --no-audit --no-fund'],
    test: 'npx --no-install vitest run || npm test --silent',
    timeoutSec: 900,
    runsLocally: true,
  },
  'WXYC/Backend-Service': {
    lang: 'ts',
    setup: ['npm ci --no-audit --no-fund || npm install --no-audit --no-fund'],
    test: 'npm test --silent',
    timeoutSec: 900,
    runsLocally: true,
  },
  'WXYC/wxyc-etl': {
    lang: 'rust',
    setup: ['cargo fetch'],
    test: 'cargo test --quiet',
    timeoutSec: 1200,
    runsLocally: true,
    note: 'Rust unit tests gate; PLpgSQL paths that need a live DB fall to parse-only per-file at build time.',
  },
  'WXYC/wxyc-ios-64': {
    lang: 'swift',
    setup: [],
    // Candidate; scheme/destination are resolved at build time from the checkout.
    test: 'xcodebuild test -scheme WXYC -destination "platform=iOS Simulator,name=iPhone 15" -quiet',
    timeoutSec: 1800,
    runsLocally: false,
    note: 'Defaults to parse-only; preflight may promote to gatable if xcodebuild + a simulator are present.',
  },
};

/** Look up a repo's test config, or null if the repo is not configured. */
export function repoTestConfig(repo) {
  return REPO_TESTS[repo] || null;
}
