export const meta = {
  name: 'ship-dag-wave',
  description: 'Implement + PR + Opus-review a batch of independent, already-triaged issues in parallel. Never merges — the /ship-dag skill owns the dependency-ordered merge queue.',
  phases: [
    { title: 'Implement', detail: 'one Sonnet subagent per issue, own worktree, TDD, local CI, push, open PR' },
    { title: 'Review', detail: 'one Opus subagent per PR, review the branch diff against the finding schema' },
  ],
}

// args: {
//   repo:    "owner/repo",
//   blockOn: ["correctness","security","convention","contract"], // categories that block auto-merge
//   issues:  [{ number, digest, decisions, complexity, implEffort, reviewEffort, sourceEstimate }]
//            sourceEstimate is triage's added-production-source budget (default 200).
//            decisions is triage's settled decisions, a list of strings (optional).
//            complexity ∈ "mechanical"|"normal"|"complex" (from triage); implEffort/
//            reviewEffort optional explicit overrides.
//   reviewDir: absolute dir the review subagents write their findings into
//            (the skill passes `$STATE/reviews`; it must already exist).
// }
// The skill has already triaged these issues (cleared of open questions) and
// computed per-issue effort from the rubric; this workflow just actuates them.

// The runtime may hand `args` through as a JSON string rather than an object;
// normalize so the rest of the script always sees a parsed object.
const A = typeof args === 'string' ? JSON.parse(args) : args || {}
const blockOn = (A && A.blockOn) || ['correctness', 'security', 'convention', 'contract']
const repo = A && A.repo
// Findings go to disk, not into the workflow's return value: the skill gates on
// scripts/review-gate.mjs reading these files, so a wave's whole finding set
// never has to pass back through main-session context. Mirrors SKILL.md's
// Review block — keep the two in sync.
const reviewDir = (A && A.reviewDir) || '.'

// Map triage's complexity enum → implement effort (explicit implEffort wins).
function implEffortFor(iss) {
  if (iss.implEffort) return iss.implEffort
  if (iss.complexity === 'complex') return 'high'
  if (iss.complexity === 'mechanical') return 'low'
  return 'medium'
}

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issue', 'status'],
  properties: {
    issue: { type: 'number' },
    status: { enum: ['pushed', 'blocked', 'error'] },
    branch: { type: 'string' },
    pr: { type: 'number' },
    ciStatus: { enum: ['pass', 'fail', 'none'] },
    openQuestions: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

// The review agent returns a summary; the findings themselves are written to
// `path` in references/review-schema.md's shape. The overall verdict is
// deliberately NOT part of this contract — scripts/review-gate.mjs recomputes
// it from the file, so no merge turns on a model's claim about its own output.
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issue', 'path', 'findingCount'],
  properties: {
    issue: { type: 'number' },
    path: { type: 'string' },
    findingCount: { type: 'number' },
    headline: { type: 'string' },
    status: { type: 'string' },
    notes: { type: 'string' },
  },
}

// Same heading and bullets as scripts/emit-config.mjs's withDecisions (workflow.js takes no imports;
// lease-rules.test.mjs pins the two together). Non-string entries are skipped; no decisions, or all blank, adds nothing.
function decisionLines(decisions) {
  const lines = (decisions || []).filter((d) => typeof d === 'string').map((d) => d.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ').trim()).filter(Boolean)
  return lines.length ? ['Settled decisions (binding; they override the issue body where they differ):', ...lines.map((d) => `- ${d}`), ``] : []
}

function implementPrompt(iss) {
  return [
    `You are implementing GitHub issue ${repo}#${iss.number} in a fresh, disposable git worktree.`,
    ``,
    `Issue digest (from triage): ${iss.digest || '(read the issue)'}`,
    ``,
    ...decisionLines(iss.decisions),
    `Steps:`,
    `1. Locate the repo checkout for ${repo} (sibling under /Users/me/Developer/, else \`gh repo clone\`). cd into it.`,
    `2. Read repo + package CLAUDE.md and the existing patterns in the module you're touching. Match them.`,
    `3. Implement the issue test-first (failing test → code → passing test), smallest correct change, no drive-by refactors. Before pushing, check your tests: every acceptance criterion and every settled decision has a test; every failure path and boundary has a test; and for each new test, revert the line under test, see the test fail, then restore it — name any test you could not make fail in the PR body, and state in the PR body how each acceptance criterion is tested. Before you commit, find every other copy of an instruction, field list or contract you changed and update each one in this PR; that is scope, not a drive-by. Search for the old wording and the changed symbol in SKILL.md, \`workflow.js\`, \`scripts/engine/prompt.md\`, README, \`references/\`, served API mirrors, registries, ADRs and doc comments. If copies are meant to stay in sync, add or extend a test that compares them. List what you updated on a \`Mirrors:\` line in the PR body, or write \`Mirrors: none found\`. When code drives \`gh\` or another CLI, build each fake from one recorded real response per call shape (read-only commands only), kept as a fixture; a fake must never return a shape the real tool does not produce.`,
    `4. Run the repo's local CI (lint/format/typecheck/tests, or \`npm run ci:*\`). When the repo has an executable \`scripts/ci\`, run it as \`scripts/ci\` (not \`sh scripts/ci\`): it is the repo's declared local CI. Only proceed on green. Heavy commands are leased machine-wide by a hook; one may wait several minutes before it starts, which is expected. Run heavy commands in the foreground (the hook refuses background ones). A denial reading \`lease: no slot after <n>s\` means rerun the same command; it is never a test failure and never a reason to skip CI. Claude Code prefixes the denial, so the tool result may read \`PreToolUse:Bash hook error: lease: no slot after 450s …\`; a tool result containing \`lease: no slot after\` anywhere, even one prefixed "hook error", means the lease is busy, not that the hook is broken, so rerun the same command. Rerun once. After the second \`lease: no slot\` denial in the session, whichever commands they hit, stop: comment on the issue, end your final message with the exact line \`orchestrator-stop: lease-wait\`, and exit without pushing. Never wrap a command in \`cli-lease.js\` yourself, and run \`cli-lease.js\` or \`run-ci-profile.mjs\` alone in its own Bash call. **Run long commands in the foreground with an explicit timeout** (Bash \`timeout\` parameter, up to 600000 ms) — a command that outlives the default foreground window gets auto-backgrounded, and **ending your turn to "wait for the notification" ends your session**: the orchestrator treats a returned turn as completion and reaps you, stranding uncommitted work in the worktree. If something does land in the background, poll it to completion (TaskOutput) within the same turn; never end a turn while a test run, install, or push is still pending. **Never launch or drive a browser** — no Playwright/e2e runs (headed or headless), no \`gh … --web\`, no \`open <url>\`, no browser tools: browser windows disrupt the machine's human user, and e2e suites are out of scope for engine sessions. Verification is terminal-only; if a check seems to need a browser, note it as unverified instead.`,
    `5. Size check — run it as you work, and again before you commit. Your budget is ${iss.sourceEstimate || 200} added lines of production source; tests, generated data, and docs sit outside it and must never be trimmed to fit. Measure with \`git diff --stat "$(git merge-base HEAD "origin/$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)")"\` and count only the source files. Over by more than half: STOP and cut — take the change back to the last point where the tests pass and the slice stands on its own, push that, and record the remainder (what you left undone, and the seam you cut on) under a \`## Deferred\` heading in the PR body and in splitRemainder. A narrow PR that lands beats a complete one that stalls in review.`,
    `6. Commit (ghost-writer: no Claude/AI attribution anywhere), push a dedicated branch, open a PR whose body has \`Closes #${iss.number}\` and cross-references the issue.`,
    `7. If mid-implementation you hit a genuine open question (ambiguous spec, an architectural fork, a new third-party dependency) that you cannot resolve from the issue + repo conventions, STOP: return status "blocked" with the questions in openQuestions and DO NOT push a guess.`,
    ``,
    `Return the schema: issue, status (pushed|blocked|error), branch, pr, ciStatus, openQuestions, splitRemainder, notes. If you gave up on the lease (\`orchestrator-stop: lease-wait\`), return \`status: "error"\` with \`notes: "lease-wait"\`.`,
  ].join('\n')
}

// Matches SKILL.md step 4d's `$STATE/reviews/<url-encoded-ref>.json`.
function reviewPathFor(issue) {
  return `${reviewDir}/${encodeURIComponent(`${repo}#${issue}`)}.json`
}

function reviewPrompt(impl) {
  return [
    `You are the code-review gate for GitHub issue ${repo}#${impl.issue}, PR #${impl.pr} on branch ${impl.branch}.`,
    ``,
    `1. In your worktree: cd into the ${repo} checkout, \`git fetch\`, and \`gh pr checkout ${impl.pr}\` (or check out ${impl.branch}) so the branch is present.`,
    `2. Review \`git diff origin/main...HEAD\` for correctness, security, simplification, efficiency, test coverage, convention, and contract. Reason exhaustively about edge cases — you are the last gate before this reaches main; nothing downstream catches your misses.`,
    `3. Optionally, if the Skill tool is reachable, also run the built-in \`/code-review\` and union any extra findings. If it is not reachable, your inline review stands alone. Heavy commands are leased machine-wide by a hook; one may wait several minutes before it starts, which is expected. Run heavy commands in the foreground (the hook refuses background ones). A denial reading \`lease: no slot after <n>s\` means rerun the same command; it is never a test failure and never a reason to skip CI. Claude Code prefixes the denial, so the tool result may read \`PreToolUse:Bash hook error: lease: no slot after 450s …\`; a tool result containing \`lease: no slot after\` anywhere, even one prefixed "hook error", means the lease is busy, not that the hook is broken, so rerun the same command. Rerun once. After the second \`lease: no slot\` denial in the session, whichever commands they hit, stop: comment on the issue, end your final message with the exact line \`orchestrator-stop: lease-wait\`, and exit without pushing. Never wrap a command in \`cli-lease.js\` yourself, and run \`cli-lease.js\` or \`run-ci-profile.mjs\` alone in its own Bash call.`,
    `4. Classify each finding: category (correctness|security|simplification|efficiency|test-coverage|convention|contract), verdict CONFIRMED|PLAUSIBLE, and blocking true|false — your own call on whether this specific finding, not just its category, should block the merge (two test-coverage findings can differ: one blocking, one a documentary nit). Any other category — or a blank one — fails the gate closed and bounces the PR to /review-loop, which has no fix for a taxonomy error, so pick the nearest listed category rather than coining one. Do NOT decide an overall verdict — the gate is recomputed from your findings against the blocking categories (${blockOn.join(', ')}); blocking only narrows within an already-blocking category and omitting it fails toward blocking.`,
    `5. Write the full finding object — { issue, findings[] (category, verdict, blocking, file, line, summary, failure_scenario) } — as JSON to ${reviewPathFor(impl.issue)}. Return only the summary below; returning findings inline would park all of them in the orchestrator's context for the rest of the run.`,
    ``,
    `Return the schema: issue, path (the file you wrote), findingCount, headline (one line naming the most serious finding, or "no findings"). findingCount is cross-checked against the file you wrote and must equal the number of entries in its findings[] — the gate is re-run with your count and refuses to score the review if the two disagree, so an inaccurate count stalls the PR rather than flattering it. Do not mention Claude/AI anywhere. If you gave up on the lease (\`orchestrator-stop: lease-wait\`), write no review file and delete a partial one you started. If you gave up on the lease, return \`status: "error"\` with \`notes: "lease-wait"\`, \`path\` "" and \`findingCount\` 0 instead of the summary.`,
  ].join('\n')
}

const results = await pipeline(
  A.issues,
  (iss) =>
    agent(implementPrompt(iss), {
      label: `impl:#${iss.number}`,
      phase: 'Implement',
      model: 'sonnet',
      effort: implEffortFor(iss),
      isolation: 'worktree',
      schema: IMPL_SCHEMA,
    }),
  (impl) => {
    // Skip the review gate if implementation blocked on an open question or errored.
    if (!impl || impl.status !== 'pushed') return impl
    return agent(reviewPrompt(impl), {
      label: `review:#${impl.issue}`,
      phase: 'Review',
      model: 'opus',
      effort: A.issues.find((i) => i.number === impl.issue)?.reviewEffort || 'high',
      isolation: 'worktree',
      schema: REVIEW_SCHEMA,
    }).then((review) => ({ ...impl, review }))
  },
)

// The skill consumes these: run scripts/review-gate.mjs over each `review.path`
// — passing that review's `findingCount` as `--expect-findings`, which is why
// REVIEW_SCHEMA makes the field required; the count is the gate's only witness
// that the findings reached disk, and discarding it here reopens the hole on the
// fallback path that step 4d closes on the engine path — to get the verdict, then
// auto-merge the clean ones (in dependency order, with a re-gate after any
// non-trivial rebase, which passes the fresh count the same way) and escalate
// blocked/blocking ones to HITL.
return results.filter(Boolean)
