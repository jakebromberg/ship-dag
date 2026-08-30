// Tests for review-workflow.js — the step-4d review gate.
//
// Workflow scripts can't be imported: they use top-level `return` and depend on
// runtime-injected globals (agent/parallel/pipeline/log/args), and the runtime
// gives them no filesystem access, so the merge logic can't be factored into a
// module the script imports. Rather than duplicate that logic here (where it
// would drift from the copy that actually runs), this harness EXECUTES THE REAL
// FILE with those globals stubbed. Everything asserted below is therefore the
// shipped code path, not a restatement of it.
//
// What's worth pinning, in order of what a silent break would cost:
//   1. `incomplete` when a pass dies — the one bug that would let an unreviewed
//      PR through the gate wearing a `clean` verdict.
//   2. The `--block-on` gate: CONFIRMED ∧ blocking-category, nothing looser.
//   3. Effort selection by `reach`, since it is the whole point of the split.
//   4. Dedupe keeping the CONFIRMED copy when two passes disagree.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'review-workflow.js')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

/**
 * Run the real review-workflow.js with stubbed workflow globals.
 *
 * `respond` maps a label like "verify:#7" / "explore:#7" to the object that
 * agent() should resolve with — return `null` to model a pass that died, which
 * is exactly what the engine hands back for a terminal agent error.
 */
async function runWorkflow(args, respond) {
  let src = await readFile(SCRIPT, 'utf8')
  // `export` is illegal inside a function body; the runtime strips the meta
  // block itself. Everything after it is the part under test.
  src = src.replace('export const meta', 'const meta')

  const calls = []
  const agent = async (prompt, opts) => {
    calls.push({ label: opts.label, model: opts.model, effort: opts.effort, phase: opts.phase, prompt })
    return respond(opts.label, prompt)
  }
  const parallel = async (thunks) =>
    Promise.all(
      thunks.map(async (t) => {
        try {
          return await t()
        } catch {
          return null
        }
      })
    )
  const pipeline = async (items, ...stages) =>
    Promise.all(
      items.map(async (item) => {
        let acc = item
        for (const stage of stages) acc = await stage(acc)
        return acc
      })
    )
  const logs = []
  const log = (m) => logs.push(m)

  const fn = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'log', src)
  const result = await fn(args, agent, parallel, pipeline, log)
  return { result, calls, logs }
}

const pr = (over = {}) => ({
  ref: 'o/r#1',
  repo: 'o/r',
  issue: 1,
  pr: 7,
  branch: 'feat/x',
  baseBranch: 'main',
  decisions: ['The store row is named `azuracast`.'],
  ...over,
})

const finding = (over = {}) => ({
  category: 'correctness',
  verdict: 'CONFIRMED',
  file: 'a.ts',
  line: 10,
  summary: 'boom',
  failure_scenario: 'x → y',
  ...over,
})

test('a dead pass marks the row incomplete even when the survivor is clean', async () => {
  const { result, logs } = await runWorkflow({ prs: [pr()] }, (label) =>
    label.startsWith('verify') ? { findings: [] } : null
  )
  assert.equal(result.length, 1)
  assert.equal(result[0].incomplete, true)
  // The verdict still reads "clean" — which is precisely why `incomplete` has to
  // exist as a separate signal rather than being folded into the verdict.
  assert.equal(result[0].review.verdict, 'clean')
  assert.equal(result[0].passes.explore.ran, false)
  assert.ok(logs.some((l) => l.includes('INCOMPLETE')))
})

test('both passes returning marks the row complete', async () => {
  const { result } = await runWorkflow({ prs: [pr()] }, () => ({ findings: [] }))
  assert.equal(result[0].incomplete, false)
  assert.equal(result[0].review.verdict, 'clean')
})

test('blocks only on a CONFIRMED finding in a blocking category', async () => {
  const cases = [
    [finding({ verdict: 'CONFIRMED', category: 'correctness' }), 'blocking'],
    [finding({ verdict: 'PLAUSIBLE', category: 'correctness' }), 'nits-only'],
    [finding({ verdict: 'CONFIRMED', category: 'efficiency' }), 'nits-only'],
    [finding({ verdict: 'CONFIRMED', category: 'security' }), 'blocking'],
  ]
  for (const [f, expected] of cases) {
    const { result } = await runWorkflow({ prs: [pr()] }, (label) =>
      label.startsWith('explore') ? { findings: [f] } : { findings: [] }
    )
    assert.equal(result[0].review.verdict, expected, `${f.verdict}/${f.category}`)
  }
})

test('a custom blockOn widens the gate', async () => {
  const { result } = await runWorkflow(
    { blockOn: ['efficiency'], prs: [pr()] },
    (label) => (label.startsWith('explore') ? { findings: [finding({ category: 'efficiency' })] } : { findings: [] })
  )
  assert.equal(result[0].review.verdict, 'blocking')
})

test('the same defect found by both passes is reported once, keeping CONFIRMED', async () => {
  const { result } = await runWorkflow({ prs: [pr()] }, (label) =>
    label.startsWith('verify')
      ? { findings: [finding({ verdict: 'PLAUSIBLE' })] }
      : { findings: [finding({ verdict: 'CONFIRMED' })] }
  )
  assert.equal(result[0].review.findings.length, 1)
  assert.equal(result[0].review.findings[0].verdict, 'CONFIRMED')
  assert.equal(result[0].review.verdict, 'blocking')
})

test('findings that differ in substance are both kept', async () => {
  const { result } = await runWorkflow({ prs: [pr()] }, (label) =>
    label.startsWith('verify')
      ? { findings: [finding({ summary: 'one', line: 1 })] }
      : { findings: [finding({ summary: 'two', line: 2 })] }
  )
  assert.equal(result[0].review.findings.length, 2)
})

test('explore effort follows reach; verify stays cheap', async () => {
  for (const [reach, expected] of [
    ['in-diff', 'medium'],
    ['repo', 'high'],
    ['external', 'xhigh'],
    [undefined, 'high'], // default when reach is unset
  ]) {
    const { calls } = await runWorkflow({ prs: [pr({ reach })] }, () => ({ findings: [] }))
    const explore = calls.find((c) => c.label.startsWith('explore'))
    const verify = calls.find((c) => c.label.startsWith('verify'))
    assert.equal(explore.effort, expected, `reach=${reach}`)
    assert.equal(verify.effort, 'medium', `reach=${reach}`)
    assert.equal(explore.model, 'opus')
    assert.equal(verify.model, 'opus')
  }
})

test('explicit efforts override the reach rubric', async () => {
  const { calls } = await runWorkflow(
    { prs: [pr({ reach: 'in-diff', exploreEffort: 'max', verifyEffort: 'high' })] },
    () => ({ findings: [] })
  )
  assert.equal(calls.find((c) => c.label.startsWith('explore')).effort, 'max')
  assert.equal(calls.find((c) => c.label.startsWith('verify')).effort, 'high')
})

test('the explore pass is not handed the decision checklist', async () => {
  const decisions = ['NEEDLE-DECISION-TEXT']
  const { calls } = await runWorkflow({ prs: [pr({ decisions })] }, () => ({ findings: [] }))
  const verify = calls.find((c) => c.label.startsWith('verify'))
  const explore = calls.find((c) => c.label.startsWith('explore'))
  // The whole reason for two passes: a checklist is a gradient the model
  // follows, so the discovery pass must not receive one.
  assert.ok(verify.prompt.includes('NEEDLE-DECISION-TEXT'))
  assert.ok(!explore.prompt.includes('NEEDLE-DECISION-TEXT'))
})

test('scope, when given, reaches both passes', async () => {
  const { calls } = await runWorkflow({ prs: [pr({ scope: 'ONLY-THESE-FILES' })] }, () => ({ findings: [] }))
  assert.ok(calls.every((c) => c.prompt.includes('ONLY-THESE-FILES')))
})

test('an empty PR list spawns no agents', async () => {
  const { result, calls } = await runWorkflow({ prs: [] }, () => {
    throw new Error('should not spawn')
  })
  assert.deepEqual(result, [])
  assert.equal(calls.length, 0)
})

test('args arriving as a JSON string is handled', async () => {
  const { result } = await runWorkflow(JSON.stringify({ prs: [pr()] }), () => ({ findings: [] }))
  assert.equal(result.length, 1)
})

test('each PR gets exactly two passes, and PRs are independent', async () => {
  const { result, calls } = await runWorkflow(
    { prs: [pr({ pr: 7, issue: 1 }), pr({ pr: 8, issue: 2, ref: 'o/r#2' })] },
    (label) => (label.endsWith('#8') && label.startsWith('explore') ? null : { findings: [] })
  )
  assert.equal(calls.length, 4)
  const seven = result.find((r) => r.pr === 7)
  const eight = result.find((r) => r.pr === 8)
  assert.equal(seven.incomplete, false)
  assert.equal(eight.incomplete, true) // one PR's dead pass must not taint the other
})
