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
//   blockOn: ["correctness","security"],          // categories that block auto-merge
//   issues:  [{ number, digest, complexity, implEffort, reviewEffort }]
//            complexity ∈ "mechanical"|"normal"|"complex" (from triage); implEffort/
//            reviewEffort optional explicit overrides.
// }
// The skill has already triaged these issues (cleared of open questions) and
// computed per-issue effort from the rubric; this workflow just actuates them.

// The runtime may hand `args` through as a JSON string rather than an object;
// normalize so the rest of the script always sees a parsed object.
const A = typeof args === 'string' ? JSON.parse(args) : args || {}
const blockOn = (A && A.blockOn) || ['correctness', 'security']
const repo = A && A.repo

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

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issue', 'verdict', 'findings'],
  properties: {
    issue: { type: 'number' },
    verdict: { enum: ['clean', 'blocking', 'nits-only'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'verdict', 'summary'],
        properties: {
          category: { enum: ['correctness', 'security', 'simplification', 'efficiency', 'test-coverage'] },
          verdict: { enum: ['CONFIRMED', 'PLAUSIBLE'] },
          file: { type: 'string' },
          line: { type: 'number' },
          summary: { type: 'string' },
          failure_scenario: { type: 'string' },
        },
      },
    },
  },
}

function implementPrompt(iss) {
  return [
    `You are implementing GitHub issue ${repo}#${iss.number} in a fresh, disposable git worktree.`,
    ``,
    `Issue digest (from triage): ${iss.digest || '(read the issue)'}`,
    ``,
    `Steps:`,
    `1. Locate the repo checkout for ${repo} (sibling under /Users/jake/Developer/, else \`gh repo clone\`). cd into it.`,
    `2. Read repo + package CLAUDE.md and the existing patterns in the module you're touching. Match them.`,
    `3. Implement the issue test-first (failing test → code → passing test), smallest correct change, no drive-by refactors.`,
    `4. Run the repo's local CI (lint/format/typecheck/tests, or \`npm run ci:*\`). Only proceed on green.`,
    `5. Commit (ghost-writer: no Claude/AI attribution anywhere), push a dedicated branch, open a PR whose body has \`Closes #${iss.number}\` and cross-references the issue.`,
    `6. If mid-implementation you hit a genuine open question (ambiguous spec, an architectural fork, a new third-party dependency) that you cannot resolve from the issue + repo conventions, STOP: return status "blocked" with the questions in openQuestions and DO NOT push a guess.`,
    ``,
    `Return the schema: issue, status (pushed|blocked|error), branch, pr, ciStatus, openQuestions, notes.`,
  ].join('\n')
}

function reviewPrompt(impl) {
  return [
    `You are the code-review gate for GitHub issue ${repo}#${impl.issue}, PR #${impl.pr} on branch ${impl.branch}.`,
    ``,
    `1. In your worktree: cd into the ${repo} checkout, \`git fetch\`, and \`gh pr checkout ${impl.pr}\` (or check out ${impl.branch}) so the branch is present.`,
    `2. Review \`git diff origin/main...HEAD\` for correctness, security, simplification, efficiency, and test coverage. Reason exhaustively about edge cases — you are the last gate before this reaches main; nothing downstream catches your misses.`,
    `3. Optionally, if the Skill tool is reachable, also run the built-in \`/code-review\` and union any extra findings. If it is not reachable, your inline review stands alone.`,
    `4. Classify: verdict "blocking" if any finding is CONFIRMED in a blocking category (${blockOn.join(', ')}); "nits-only" if only non-blocking/ PLAUSIBLE findings; "clean" if none.`,
    ``,
    `Return the schema: issue, verdict, findings[] (category, verdict CONFIRMED|PLAUSIBLE, file, line, summary, failure_scenario). Do not mention Claude/AI anywhere.`,
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

// The skill consumes these: auto-merge the clean ones (in dependency order, with a
// re-gate after any non-trivial rebase), and escalate blocked/blocking ones to HITL.
return results.filter(Boolean)
