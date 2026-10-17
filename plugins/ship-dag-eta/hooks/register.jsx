// register.jsx — the ship-dag-eta mod: the ETA of the active ship-dag run as a progress bar on the status line, a pane
// with the bar's points of interest (/ship-dag-eta-bar), and the full estimate (/ship-dag-eta).
//
// Every two minutes (and at session start) it finds the newest run under the ship-dag state base, and when that run's
// dirs changed in the last six hours, recomputes its ETA from the local state, pins one status line (a compact bar,
// the merged count, the likely finish and its range in Pacific time, the binding constraint, the as-of time) and
// keeps the bar's model in `$.state`, which redraws the pane when it is open. With no active run the line is cleared.
// The pane opens only when the person runs the command, and never asks for focus. GitHub's answer (one GraphQL
// query) is kept in the plugin's store for five minutes, so every session running the mod shares one fetch. The
// model, the state reader and the bar layout are ../lib, the same files the repo's CLI and tests run. When each
// ticket passed review is the review gate's to say, and the gate is Node code in the ship-dag skill, so the mod asks
// the skill's scripts/eta/review-passes.mjs through `node` (cached the same way); without the skill, depth falls
// back to its default and the estimate says why.

import { formatPacific, renderText } from '../lib/model.mjs';
import { computeEta, familyDirs, latestRun } from '../lib/state.mjs';
import { barModel, compactBar, renderBar } from '../lib/bar.mjs';

const REFRESH_MS = 2 * 60_000;
const GH_TTL_MS = 5 * 60_000;
const ACTIVE_MS = 6 * 3_600_000;
const BAR = { plugin: 'ship-dag-eta', key: 'bar' };
const NO_RUN = 'There is no active ship-dag run (none changed in the last six hours).';

/** @param {import('claude-code').EngineInterface} $ */
async function stateBase($) {
  const xdg = await $.env.get('XDG_STATE_HOME');
  const home = await $.env.get('HOME');
  return `${xdg || `${home}/.local/state`}/ship-dag/engine`;
}

/** Memoizes `fn` by its one argument, so a path is read at most once per estimate. */
const once = (fn) => {
  const seen = new Map();
  return (key) => (seen.has(key) ? seen.get(key) : seen.set(key, fn(key)).get(key));
};

/** The `io` state.mjs reads through, over `$.fs`, each path read once; entries carry their mtime. @param {import('claude-code').EngineInterface} $ */
const fsIo = ($) => ({
  list: once(async (dir) => (await $.fs.list(dir).catch(() => [])).map((e) => ({ name: e.name, isDir: e.kind === 'dir', mtimeMs: e.mtimeMs }))),
  read: once((path) => $.fs.read(path).then((t) => (typeof t === 'string' ? t : null), () => null)),
  mtime: once((path) => $.fs.stat(path).then((s) => s.mtimeMs, () => null)),
});

/**
 * `argv` through `$.process.run`, its stdout kept in the store under `slot` for GH_TTL_MS per argv. The slot holds
 * every argv still fresh, so a named run's query does not evict the active run's; expired entries are dropped on write.
 * @param {import('claude-code').EngineInterface} $
 */
async function cachedRun($, now, slot, argv) {
  const key = argv.join('\n');
  const held = /** @type {Record<string, {at: number, stdout: string}> | undefined} */ (await $.store.get(slot)) ?? {};
  const hit = held[key];
  if (hit && now - hit.at < GH_TTL_MS) {
    return hit.stdout;
  }
  const { exitCode, stdout, stderr } = await $.process.run(argv, { timeoutMs: 60_000 });
  if (exitCode !== 0) {
    throw new Error(stderr.trim().split('\n')[0] || `${argv[0]} exited ${exitCode}`);
  }
  const fresh = Object.fromEntries(Object.entries(held).filter(([, v]) => now - v?.at < GH_TTL_MS));
  await $.store.set(slot, { ...fresh, [key]: { at: now, stdout } });
  return stdout;
}

/** The skill's review-passes CLI, run through `node`: each ref's review pass as a Map. @param {import('claude-code').EngineInterface} $ */
const skillReviews = ($, now) => async ({ base, runId, refs }) => {
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`;
  const script = `${config}/skills/ship-dag/scripts/eta/review-passes.mjs`;
  if (!(await $.fs.exists(script))) {
    throw new Error(`no ship-dag skill at ${script}`);
  }
  const argv = ['node', script, '--state-base', base, '--run', runId, '--refs', refs.join(',')];
  return new Map(Object.entries(JSON.parse(await cachedRun($, now, 'reviews', argv))));
};

/**
 * When the run's family (state.mjs's `familyDirs`) last changed: each dir, its reviews, reports and per-ticket
 * metadata, and every file directly in them, since a file rewritten in place leaves its dir's mtime alone.
 */
async function lastActivity(io, base, runId) {
  const paths = (await familyDirs(io, base, runId)).flatMap((dir) => ['', '/reviews', '/state/reports', '/state/metadata'].map((sub) => `${dir}${sub}`));
  const times = await Promise.all(paths.map(async (p) => {
    const [own, entries] = await Promise.all([io.mtime(p), io.list(p)]);
    return Math.max(own ?? 0, ...entries.map((e) => e.mtimeMs));
  }));
  return Math.max(0, ...times);
}

/** The estimate for `runId`, or for the newest run when it changed within ACTIVE_MS; null when there is no such run. */
async function estimateFor($, runId) {
  const now = await $.clock.now();
  const base = await stateBase($);
  const io = fsIo($);
  const id = runId || (await latestRun(io, base));
  if (!id || (!runId && now - (await lastActivity(io, base, id)) > ACTIVE_MS)) {
    return null;
  }
  const gh = (args) => cachedRun($, now, 'gh', ['gh', ...args]);
  return computeEta({ io, gh, reviews: skillReviews($, now), base, runId: id, now, warn: (m) => $.ui.log(`ship-dag-eta: ${m}`, { to: 'debug' }) });
}

/** The status line: the compact bar, the merged count, likely finish, its range, the binding constraint and the as-of time. */
export function statusLine(r, b) {
  if (r.binding === 'done') {
    return `ship-dag ${r.runId}: nothing left to merge, as of ${formatPacific(r.now)}`;
  }
  return `ship-dag ${compactBar(b)} ${b.merged}/${b.total} merged, ETA ${formatPacific(r.eta.mid)} (${formatPacific(r.eta.lo)} to ${formatPacific(r.eta.hi)}), bound by ${r.binding}, as of ${formatPacific(r.now)}`;
}

/** @param {import('claude-code').EngineInterface} $ */
async function refresh($) {
  try {
    const r = await estimateFor($);
    const b = r && !r.error ? barModel(r) : null;
    $.ui.status(b ? statusLine(r, b) : undefined);
    await $.state.set(BAR, b);
  } catch (err) {
    $.ui.log(`ship-dag-eta: refresh failed: ${err?.message ?? err}`, { to: 'debug' });
  }
}

/** @type {import('claude-code').Register} */
export const register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ship-dag-eta', description: 'ETA of the active ship-dag run (or of the run named)', argumentHint: '[runId]' });
    await $.command.register({ name: 'ship-dag-eta-bar', description: 'Open a pane with the active ship-dag run as a progress bar over time' });
    $.clock.every(REFRESH_MS, () => refresh($));
    // Not awaited: the first estimate waits on gh and node (up to a minute each), and session start must not.
    refresh($);
    return next(e);
  });

  on('command.run', { command: 'ship-dag-eta' }, async ($, e) => {
    try {
      const r = await estimateFor($, e.args.trim());
      if (!r) {
        return { text: `${NO_RUN} Name one: /ship-dag-eta <runId>` };
      }
      return { text: r.error ? `ship-dag-eta: ${r.error}` : renderText(r) };
    } catch (err) {
      return { text: `ship-dag-eta: ${err?.message ?? err}` };
    }
  });

  on('command.run', { command: 'ship-dag-eta-bar' }, async ($) => {
    await $.ui.open({ id: 'ship-dag-eta', title: 'ship-dag ETA' });
    return { text: 'Opened the ship-dag ETA pane.' };
  });

  on('ui.render', { component: 'Pane', requestId: 'ship-dag-eta' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    const { value } = await $.state.get(BAR);
    const lines = value ? renderBar(value, e.props.bodyColumns) : [NO_RUN];
    return (
      <Box flexDirection="column">
        {lines.map((line) => (
          <Text wrap="truncate">{line}</Text>
        ))}
      </Box>
    );
  });
};
