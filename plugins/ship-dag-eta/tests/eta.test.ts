// Tests for the ship-dag-eta mod. Run: claude plugin test plugins/ship-dag-eta
//
// The world beneath the mod is answered here: the env, a state dir held in memory (fs.list, fs.read, fs.stat), gh
// (process.run), a store and a clock that moves only when the test moves it.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const MIN = 60_000
const NOW = Date.parse('2026-10-17T18:00:00Z')
const BASE = '/home/me/.local/state/ship-dag/engine'
const RUN = 'sd-20261017-080000'

type Tree = Record<string, { text?: string; mtimeMs: number }>

/** A run with o/r#1 merged and o/r#2, o/r#3 open, its files last touched `touchedAt`. */
function runTree(touchedAt: number): Tree {
  const file = (value: unknown) => ({ text: JSON.stringify(value), mtimeMs: touchedAt })
  return {
    [`${BASE}/${RUN}/dag.json`]: file({ repo: 'o/r', nodes: [{ ref: 'o/r#2' }, { ref: 'o/r#3' }], edges: [], done: ['o/r#1'], members: ['o/r#1', 'o/r#2', 'o/r#3'] }),
    [`${BASE}/${RUN}/plan.json`]: file({ waves: [['o/r#2'], ['o/r#3']], blocked: [], cyclic: [] }),
    [`${BASE}/${RUN}/state/metadata/issue-${encodeURIComponent('o/r#1')}.json`]: file({ startedAt: '2026-10-17T16:30:00Z' }),
  }
}

const answer = JSON.stringify({
  data: {
    r0: {
      i1: { state: 'CLOSED', stateReason: 'COMPLETED', closedAt: '2026-10-17T17:00:00Z', closedByPullRequestsReferences: { nodes: [{ mergedAt: '2026-10-17T17:00:00Z' }] } },
      i2: { state: 'OPEN', stateReason: null, closedAt: null, closedByPullRequestsReferences: { nodes: [] } },
      i3: { state: 'OPEN', stateReason: null, closedAt: null, closedByPullRequestsReferences: { nodes: [] } },
    },
  },
})

/**
 * Answers the mod's file system and gh from `tree`, and the skill's review-passes CLI with `passes`; returns what it
 * ran and the status lines it set. A dir's mtime is its newest file's, unless `dirMtimeMs` pins every dir's.
 */
function world(on: On, tree: Tree, passes: Record<string, number> = {}, { dirMtimeMs, hangGh = false }: { dirMtimeMs?: number; hangGh?: boolean } = {}) {
  const gh: string[][] = []
  const nodeRuns: string[][] = []
  const opened: Record<string, unknown>[] = []
  const statuses: (string | undefined)[] = []
  const children = (dir: string) => {
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of Object.keys(tree)) {
      if (path.startsWith(`${dir}/`)) {
        const rest = path.slice(dir.length + 1).split('/')
        names.set(rest[0]!, rest.length > 1 ? 'dir' : 'file')
      }
    }
    return [...names]
  }
  const newest = (dir: string) => Math.max(0, ...Object.entries(tree).filter(([p]) => p.startsWith(`${dir}/`)).map(([, f]) => f.mtimeMs))
  mock.env(on, { HOME: '/home/me' })
  mock.store(on)
  on('fs.list', ($, e) => ({ value: children(e.path).map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: kind === 'file' ? tree[`${e.path}/${name}`]!.mtimeMs : 0, isLink: false })) }))
  on('fs.read', ($, e) => {
    const f = tree[e.path]
    return f?.text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: f.text }
  })
  on('fs.stat', ($, e) => {
    const f = tree[e.path]
    const kind = f ? 'file' : children(e.path).length ? 'dir' : undefined
    return kind ? { value: { kind, size: 0, mtimeMs: f?.mtimeMs ?? dirMtimeMs ?? newest(e.path), isLink: false } } : { deny: `ENOENT: ${e.path}` }
  })
  on('process.run', ($, e) => {
    const ran = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'node') {
      nodeRuns.push([...e.argv])
      return ran(JSON.stringify(passes))
    }
    gh.push([...e.argv])
    return hangGh ? new Promise<never>(() => {}) : ran(answer)
  })
  on('fs.exists', ($, e) => ({ value: e.path in tree }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    opened.push({ ...e })
    return { value: { isPlaced: true } }
  })
  return { gh, statuses, nodeRuns, opened }
}

const start = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

test('an active run shows its ETA in Pacific time, its binding constraint and the as-of time on the status line', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = world(on, runTree(NOW - 10 * MIN))
  await $.session.start(start)
  await clock.settle()
  const line = seen.statuses.at(-1)
  expect(line).toMatch(/^ship-dag \[[█▓░·]*[^█▓░·\]][█▓░·]*\] 1\/3 merged, ETA .* P[DS]T/)
  expect(line!.slice('ship-dag ['.length, line!.indexOf(']'))).toHaveLength(20)
  expect(line).toMatch(/bound by (depth|queue o\/r|throughput)/)
  expect(line).toMatch(/as of Sat, Oct 17, 11:00 AM PDT/)
})

test('a run whose open tickets are all blocked says it is waiting, not that nothing is left', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const tree = runTree(NOW - 10 * MIN)
  tree[`${BASE}/${RUN}/plan.json`] = { text: JSON.stringify({ waves: [], blocked: [{ ref: 'o/r#2' }, { ref: 'o/r#3' }], cyclic: [] }), mtimeMs: NOW - 10 * MIN }
  const seen = world(on, tree)
  await $.session.start(start)
  await clock.settle()
  expect(seen.statuses.at(-1)).toMatch(/^ship-dag sd-20261017-080000: waiting on 2 blocked tickets, as of Sat, Oct 17, 11:00 AM PDT$/)
})

test('the status line refreshes on its own and fetches from GitHub at most once in five minutes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = world(on, runTree(NOW - 10 * MIN))
  await $.session.start(start)
  await clock.settle()
  await clock.advance(2 * MIN)
  expect(seen.statuses.at(-1)).toMatch(/as of Sat, Oct 17, 11:02 AM PDT/)
  expect(seen.gh).toHaveLength(1)
  await clock.advance(4 * MIN)
  expect(seen.gh).toHaveLength(2)
  expect(seen.gh[0]!.slice(0, 2)).toEqual(['gh', 'api'])
})

test('with no run touched in the last six hours the status line is clear and the command says no active run', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = world(on, runTree(NOW - 7 * 60 * MIN))
  await $.session.start(start)
  await clock.settle()
  expect(seen.statuses.at(-1)).toBeUndefined()
  expect(seen.gh).toHaveLength(0)
  const { text } = await $.command.run({ command: 'ship-dag-eta', args: '' })
  expect(text).toMatch(/no active ship-dag run/)
})

test('the command prints the whole estimate, for a named run whatever its age', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, runTree(NOW - 7 * 60 * MIN))
  await $.session.start(start)
  await clock.settle()
  const { text } = await $.command.run({ command: 'ship-dag-eta', args: RUN })
  expect(text).toMatch(`ship-dag ETA for ${RUN}`)
  expect(text).toMatch(/o\/r +1 +2/)
  expect(text).toMatch(/0 blocked, not counted/)
})

const GATE = '/home/me/.claude/skills/ship-dag/scripts/eta/review-passes.mjs'

test('depth runs from each ticket\'s latest engine start to its review pass, read through the ship-dag skill\'s review gate', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const tree = runTree(NOW - 10 * MIN)
  const meta = (ref: string, startedAt: string) => ({ [`${BASE}/${RUN}-w1b/state/metadata/issue-${encodeURIComponent(ref)}.json`]: { text: JSON.stringify({ startedAt }), mtimeMs: NOW - 10 * MIN } })
  Object.assign(tree, meta('o/r#1', '2026-10-17T17:00:00Z'), meta('o/r#2', '2026-10-17T17:00:00Z'), meta('o/r#3', '2026-10-17T17:10:00Z'), { [GATE]: { text: '', mtimeMs: 0 } })
  const passes = { 'o/r#1': Date.parse('2026-10-17T17:20:00Z'), 'o/r#2': Date.parse('2026-10-17T17:30:00Z'), 'o/r#3': Date.parse('2026-10-17T17:50:00Z') }
  const seen = world(on, tree, passes)
  await $.session.start(start)
  await clock.settle()
  const { text } = await $.command.run({ command: 'ship-dag-eta', args: RUN })
  expect(text).toMatch(/25m \/ 30m \/ 35m per wave \(median of 3 tickets, latest engine start to review pass\)/)
  expect(seen.nodeRuns[0]!.slice(0, 2)).toEqual(['node', GATE])
  expect(seen.nodeRuns[0]).toContain(RUN)
})

test('without the ship-dag skill the depth falls back to its default and the estimate says why', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = world(on, runTree(NOW - 10 * MIN))
  await $.session.start(start)
  await clock.settle()
  const { text } = await $.command.run({ command: 'ship-dag-eta', args: RUN })
  expect(text).toMatch(/Note: review rounds unreadable \(no ship-dag skill at .*review-passes\.mjs\)/)
  expect(text).toMatch(/default: 0 of 3 samples/)
  expect(seen.nodeRuns).toHaveLength(0)
})

test('a run whose files were rewritten in place within six hours is active, though its dirs are older', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const tree = runTree(NOW - 7 * 60 * MIN)
  tree[`${BASE}/${RUN}/state/metadata/issue-${encodeURIComponent('o/r#1')}.json`]!.mtimeMs = NOW - 10 * MIN
  const seen = world(on, tree, {}, { dirMtimeMs: NOW - 7 * 60 * MIN })
  await $.session.start(start)
  await clock.settle()
  expect(seen.statuses.at(-1)).toMatch(/^ship-dag \[.{20}\] 1\/3 merged, ETA /)
})

test('session start does not wait for the first estimate', async ($, on) => {
  mock.clock(on, { now: NOW })
  const seen = world(on, runTree(NOW - 10 * MIN), {}, { hangGh: true })
  const { cwd } = await $.session.start(start)
  expect(cwd).toBe('/tmp')
  expect(seen.statuses).toHaveLength(0)
})

const PANE = { component: 'Pane', requestId: 'ship-dag-eta' } as const

test('the pane never opens on its own, and /ship-dag-eta-bar opens it without taking focus', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = world(on, runTree(NOW - 10 * MIN))
  await $.session.start(start)
  await clock.settle()
  await clock.advance(10 * MIN)
  expect(seen.opened).toHaveLength(0)
  await $.command.run({ command: 'ship-dag-eta-bar', args: '' })
  expect(seen.opened).toHaveLength(1)
  expect(seen.opened[0]).toMatchObject({ id: 'ship-dag-eta' })
  expect(seen.opened[0]!.focus).toBeUndefined()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane draws the full bar with its legend when wide, and the compact bar when narrow (${surface})`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on, runTree(NOW - 10 * MIN))
    await $.session.start(start)
    await clock.settle()
    const wide = await $.ui.mount({ plugin: 'ship-dag-eta', surface, ...PANE, props: { title: 'ship-dag ETA', isFocused: false, bodyColumns: 80 } })
    expect(await wide.find({ type: 'Text', text: /1\/3 merged/ })).toBeDefined()
    expect(await wide.find({ type: 'Text', text: /now +Sat, Oct 17, 11:00 AM PDT/ })).toBeDefined()
    expect(await wide.find({ type: 'Text', text: /\(binding\)/ })).toBeDefined()
    await wide.unmount()
    const narrow = await $.ui.mount({ plugin: 'ship-dag-eta', surface, ...PANE, props: { title: 'ship-dag ETA', isFocused: false, bodyColumns: 40 } })
    expect(await narrow.find({ type: 'Text', text: /^\[.{20}\] 1\/3 merged$/ })).toBeDefined()
    expect(await narrow.find({ type: 'Text', text: /^bound by / })).toBeDefined()
    await narrow.unmount()
  })
}

test('with no active run the pane says so', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, runTree(NOW - 7 * 60 * MIN))
  await $.session.start(start)
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'ship-dag-eta', surface: 'terminal', ...PANE, props: { title: 'ship-dag ETA', isFocused: false, bodyColumns: 80 } })
  expect(await pane.find({ type: 'Text', text: /no active ship-dag run/i })).toBeDefined()
})
