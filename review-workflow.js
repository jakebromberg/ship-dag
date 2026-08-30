export const meta = {
  name: 'ship-dag-review',
  description:
    'Opus review gate over PRs the engine already opened. Two passes per PR at different efforts — confirm the enumerated decisions, and separately hunt for what nobody asked — merged into one verdict. Never merges.',
  phases: [
    { title: 'Verify', detail: 'opus/medium — confirm each binding decision actually landed in the code' },
    { title: 'Explore', detail: 'opus/high–xhigh — open-ended hunt, deliberately not given the checklist' },
  ],
}

// args: {
//   blockOn: ["correctness","security"],   // categories that block auto-merge
//   prs: [{
//     ref, repo, issue, pr, branch, baseBranch,
//     decisions?: [ "..." ],               // the binding decisions to confirm (verify pass)
//     scope?:     "path glob or prose",    // narrow the diff both passes read
//     verifyEffort?, exploreEffort?,       // explicit overrides; else the rubric below
//     reach?: "in-diff" | "repo" | "external",   // drives exploreEffort
//   }]
// }
//
// WHY TWO PASSES. One agent handed both jobs does the checklist and calls it a
// day: an enumerated list is a gradient the model follows, and open-ended
// discovery is what gets crowded out. Splitting them lets the expensive pass
// run without a checklist competing for its attention, and lets the cheap pass
// be cheap — confirming "is `NULLS LAST` present" does not need xhigh.
//
// The two are also asymmetric in what a miss costs. A missed confirmation is
// recoverable: the decision was written down, so the next reader can check it.
// A missed discovery is not — nobody downstream is looking. That asymmetry, not
// the subject matter, is why the floors differ.

const A = typeof args === 'string' ? JSON.parse(args) : args || {}
const blockOn = A.blockOn || ['correctness', 'security']
const prs = A.prs || []

if (!prs.length) {
  log('no PRs handed to the review gate — nothing to do')
  return []
}

/**
 * Explore effort keyed on REACH: how far the reasoning has to travel from the
 * diff to reach a verdict. This is deliberately a property of the change, not
 * of how alarming the subject sounds — "touches auth" is a vibe, "the verdict
 * requires reading a third-party library's source" is checkable.
 *
 *   in-diff  → medium  everything needed is in the diff and the issue
 *   repo     → high    needs surrounding code: callers, schema, siblings, lockfile
 *   external → xhigh   needs third-party internals, production-scale arithmetic,
 *                      or a cross-repo contract closure
 *
 * `repo` is the default because it is the common case and the one where
 * under-spending is silently expensive.
 */
const EXPLORE_EFFORT_BY_REACH = { 'in-diff': 'medium', repo: 'high', external: 'xhigh' }

function exploreEffortFor(pr) {
  return pr.exploreEffort || EXPLORE_EFFORT_BY_REACH[pr.reach] || 'high'
}

// The verify pass never needs to reason far — it is checking stated claims
// against code. It stays cheap unless a caller says otherwise.
function verifyEffortFor(pr) {
  return pr.verifyEffort || 'medium'
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
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
    notes: { type: 'string' },
  },
}

function diffPreamble(pr) {
  const base = pr.baseBranch || 'main'
  return [
    `PR ${pr.repo}#${pr.pr} (issue ${pr.repo}#${pr.issue}), branch \`${pr.branch}\`, base \`${base}\`.`,
    ``,
    `READ-ONLY. Do not edit, commit, push, comment, or run any \`git worktree\`, \`git rebase\`,`,
    `\`git reset --hard\`, or \`git push\` command. Read the diff with`,
    `\`gh pr diff ${pr.pr} --repo ${pr.repo}\` and the file list with`,
    `\`gh pr view ${pr.pr} --repo ${pr.repo} --json files\`.`,
    ``,
    `Read the issue AND its comments first — comments supersede the body:`,
    `\`gh issue view ${pr.issue} --repo ${pr.repo} --json body,comments\``,
    pr.scope ? `\nScope your reading to: ${pr.scope}` : '',
    `\nRead the repo's CLAUDE.md for invariants, but only the sections the diff touches.`,
  ].join('\n')
}

function verifyPrompt(pr) {
  const decisions = (pr.decisions || []).map((d, i) => `${i + 1}. ${d}`).join('\n')
  return [
    `You are the CONFIRMATION half of a two-part review gate.`,
    ``,
    diffPreamble(pr),
    ``,
    `Your ONLY job is to check that each decision below actually landed in the code,`,
    `by reading the code — never by trusting the PR description or a commit message,`,
    `which are the most likely places for a wrong claim to hide.`,
    ``,
    decisions || '(No decisions were supplied. Derive them from the issue and its comments, then check each.)',
    ``,
    `For each: state CONFIRMED with the file:line that proves it, or report a finding.`,
    `A decision that is implemented but whose stated rationale is now false is still a`,
    `finding — a comment asserting an invariant the code no longer holds is worse than`,
    `no comment, because the next reader believes it.`,
    ``,
    `Also check every test the PR adds or changes: could it FAIL? Name the single-line`,
    `production mutation each one catches. A test that would still pass with the feature`,
    `deleted is a test-coverage finding, however green CI is.`,
    ``,
    `Do NOT go looking for defects outside this list — a second reviewer is doing that,`,
    `and duplicating it costs tokens without adding coverage.`,
    ``,
    `Return { findings[], notes }. Empty findings means every decision checked out.`,
  ].join('\n')
}

function explorePrompt(pr) {
  return [
    `You are the DISCOVERY half of a two-part review gate. Another reviewer is already`,
    `confirming the decisions this PR was asked to implement, so do not spend effort`,
    `re-checking a stated checklist. **Your job is what nobody thought to ask.**`,
    `Nothing downstream catches your misses — CI is green on this PR already.`,
    ``,
    diffPreamble(pr),
    ``,
    `Bias toward the failure modes that survive review because they are invisible in a diff:`,
    ``,
    `- **Scale.** Does anything here work on the fixture and break on the real population?`,
    `  Bulk inserts against bind-parameter ceilings, unbounded IN lists, an O(n) round trip`,
    `  per row, a query with no LIMIT. Find the real numbers — read the third-party`,
    `  library's source for the actual limit rather than assuming one, and do the arithmetic`,
    `  against the production size the issue or repo states.`,
    `- **Partial failure.** If this dies halfway, what is left behind? Multi-statement writes`,
    `  outside a transaction, a committed parent with no children, state no re-run repairs.`,
    `- **Contract.** Does what this WRITES match what its consumer READS, and what it EMITS`,
    `  match what the client DECODES? Trace one realistic value end to end.`,
    `- **Silent wrongness.** Values that are plausible but wrong: a truncated string used as`,
    `  a lookup key, positional correspondence assumed where order is not guaranteed, a`,
    `  fallback that fires on the healthy path.`,
    `- **Security.** Credentials or signed URLs reaching a log, an error's userInfo, or`,
    `  telemetry. Write paths against data that must only be read.`,
    `- **Tests that cannot fail.** Assertions over empty collections, a mock asserted against`,
    `  itself, a fixture that makes the branch under test unreachable.`,
    ``,
    `Verify before you report: read the code, follow the call, check the source of any`,
    `limit you rely on. Mark a finding CONFIRMED only if you traced it; otherwise PLAUSIBLE.`,
    `Do not pad with style nits — a short list of real findings is the goal.`,
    ``,
    `Return { findings[], notes }.`,
  ].join('\n')
}

// Two passes can land the same defect. Dedupe on file + line + a normalized
// summary so the merged list doesn't double-count it, keeping the CONFIRMED
// copy when the two disagree (a traced finding outranks a suspected one).
function dedupe(findings) {
  const byKey = new Map()
  for (const f of findings) {
    const key = `${f.file || ''}:${f.line ?? ''}:${(f.summary || '').toLowerCase().replace(/\W+/g, ' ').trim()}`
    const prior = byKey.get(key)
    if (!prior || (prior.verdict !== 'CONFIRMED' && f.verdict === 'CONFIRMED')) byKey.set(key, f)
  }
  return [...byKey.values()]
}

function mergeReview(pr, verify, explore) {
  // A pass that died must NEVER read as a clean review. `incomplete` is what
  // step 5 keys on to route to HITL instead of the merge queue — silence from a
  // crashed reviewer is not evidence of correctness.
  const incomplete = !verify || !explore
  const findings = dedupe([...((verify && verify.findings) || []), ...((explore && explore.findings) || [])])

  const blocked = findings.some((f) => f.verdict === 'CONFIRMED' && blockOn.includes(f.category))
  const verdict = blocked ? 'blocking' : findings.length ? 'nits-only' : 'clean'

  return {
    issue: pr.issue,
    ref: pr.ref,
    repo: pr.repo,
    pr: pr.pr,
    branch: pr.branch,
    review: { verdict, findings },
    incomplete,
    passes: {
      verify: { ran: !!verify, effort: verifyEffortFor(pr) },
      explore: { ran: !!explore, effort: exploreEffortFor(pr) },
    },
  }
}

log(
  `reviewing ${prs.length} PR(s): ` +
    prs.map((p) => `#${p.pr}[verify=${verifyEffortFor(p)},explore=${exploreEffortFor(p)}]`).join(' ')
)

// pipeline, not a barrier: each PR's two passes start together and that PR's
// verdict is merged the moment both land, so a slow xhigh explore on one PR
// never holds up another PR's result.
const reviewed = await pipeline(prs, (pr) =>
  parallel([
    () =>
      agent(verifyPrompt(pr), {
        label: `verify:#${pr.pr}`,
        phase: 'Verify',
        model: 'opus',
        effort: verifyEffortFor(pr),
        schema: FINDINGS_SCHEMA,
      }),
    () =>
      agent(explorePrompt(pr), {
        label: `explore:#${pr.pr}`,
        phase: 'Explore',
        model: 'opus',
        effort: exploreEffortFor(pr),
        schema: FINDINGS_SCHEMA,
      }),
  ]).then(([verify, explore]) => mergeReview(pr, verify, explore))
)

const out = reviewed.filter(Boolean)
for (const r of out) {
  if (r.incomplete) log(`#${r.pr}: INCOMPLETE — a review pass failed; do not auto-merge`)
}
return out
