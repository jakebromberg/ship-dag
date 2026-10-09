import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { implementCost } from './transcript-cost.mjs';

const result = (id, cost, over = {}) => JSON.stringify({
  type: 'result', subtype: 'success', session_id: id, total_cost_usd: cost,
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 4 }, ...over,
});
const noise = JSON.stringify({ type: 'assistant', message: 'hi' });
/** The cost of `results` result records (each with `result()`'s usage) across `ids`, costing `costUsd` in all. */
const costOf = (ids, costUsd, results = ids.length) => ({ costUsd, input: 10 * results, output: 20 * results, cacheRead: 300 * results, cacheCreate: 4 * results, sessions: ids.length, sessionIds: ids });

/** Run `fn` on a log holding `lines`, collecting what implementCost warns. */
function withLog(lines, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tcost-'));
  try {
    const p = join(dir, 'log');
    writeFileSync(p, lines.join('\n'));
    return fn(p, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// [name, lines, already-listed ids, want, warnings]
const cases = [
  ['two sessions sum', [noise, result('a', 1), noise, result('b', 0.5)], [], costOf(['a', 'b'], 1.5)],
  // A session that wakes for background-task notifications writes a result per wake: total_cost_usd
  // is the session's running total, usage is each result's own (as in real transcripts).
  ['a session with three results counts once: its last running total, its usage summed',
    [result('a', 1, { result_index: 0 }), noise, result('a', 1.5, { result_index: 1, origin: { kind: 'task-notification' } }),
      result('a', 2, { result_index: 2, origin: { kind: 'task-notification' } }), result('b', 0.5)], [],
    costOf(['a', 'b'], 2.5, 4)],
  ['the last result is the highest result_index', [result('a', 2, { result_index: 1 }), result('a', 1, { result_index: 0 })], [], costOf(['a'], 2, 2)],
  ['without result_index the last result is the last in the file', [result('a', 1), result('a', 3)], [], costOf(['a'], 3, 2)],
  ['no result record', [noise, noise], [], null],
  ['a hook result is not a session', [result('a', 1), result('h', 9, { hook_event_name: 'Stop' })], [], costOf(['a'], 1)],
  ['an already-listed session is skipped, every one of its results', [result('a', 1), result('b', 0.5), result('a', 2)], ['a'], costOf(['b'], 0.5)],
  ['every session already listed', [result('a', 1)], ['a'], null],
  ['a torn line is ignored', [result('a', 1), '{"type":"result",'], [], costOf(['a'], 1)],
  ['missing usage counts as zero', [result('a', 2, { usage: undefined })], [],
    { costUsd: 2, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 1, sessionIds: ['a'] }],
  // A session with no valid total_cost_usd is unpriced, not free: it is left out whole, like a killed one.
  ['a non-number cost or usage value is warned about and not summed, and an unpriced session is not counted',
    [result('a', '0.5'), result('b', 1, { usage: { input_tokens: '7', output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 4 } })], [],
    { costUsd: 1, input: 0, output: 20, cacheRead: 300, cacheCreate: 4, sessions: 1, sessionIds: ['b'] },
    [/total_cost_usd "0\.5"/, /usage\.input_tokens "7"/, /session a .*no valid total_cost_usd; not counted/]],
  ['a bad later running total keeps the last good one', [result('a', 1, { result_index: 0 }), result('a', null, { result_index: 1 })], [],
    costOf(['a'], 1, 2), [/total_cost_usd null/]],
  ['a session with no total_cost_usd is warned about and not counted, not taken for $0', [result('a', undefined), result('b', 0.5)], [], costOf(['b'], 0.5),
    [/session a .*no valid total_cost_usd; not counted/]],
  ['a session priced by any of its results is counted', [result('a', undefined, { result_index: 0 }), result('a', 2, { result_index: 1 })], [], costOf(['a'], 2, 2)],
  ['a result with no session_id is warned about and not summed', [result(undefined, 1), result('b', 0.5)], [], costOf(['b'], 0.5), [/no session_id/]],
];
for (const [name, lines, listed, want, warnings = []] of cases) {
  test(`implementCost: ${name}`, () => withLog(lines, (p) => {
    const warned = [];
    assert.deepEqual(implementCost(p, listed, (m) => warned.push(m)), want);
    assert.equal(warned.length, warnings.length, warned.join('\n'));
    warnings.forEach((re, i) => assert.match(warned[i], re));
  }));
}

test('implementCost: a missing log is null without a warning; an unreadable one is null with one', () => {
  const warned = [];
  assert.equal(implementCost('/nonexistent/log', [], (m) => warned.push(m)), null);
  assert.deepEqual(warned, []);
  withLog([], (p, dir) => {
    assert.equal(implementCost(dir, [], (m) => warned.push(m)), null);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /cannot read/);
  });
});

test('implementCost: a line longer than many chunks is read whole, and the lines around it too', () => withLog(
  [result('a', 1), JSON.stringify({ type: 'assistant', text: 'é'.repeat(200000) }), result('b', 0.5)],
  (p) => assert.deepEqual(implementCost(p), costOf(['a', 'b'], 1.5)),
));
