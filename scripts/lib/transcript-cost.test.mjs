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

const SUMMED = { costUsd: 1.5, input: 20, output: 40, cacheRead: 600, cacheCreate: 8, sessions: 2, sessionIds: ['a', 'b'] };
const cases = [
  ['two sessions sum', [noise, result('a', 1), noise, result('b', 0.5)], [], SUMMED],
  ['no result record', [noise, noise], [], null],
  ['a hook result is not a session', [result('a', 1), result('h', 9, { hook_event_name: 'Stop' })], [],
    { costUsd: 1, input: 10, output: 20, cacheRead: 300, cacheCreate: 4, sessions: 1, sessionIds: ['a'] }],
  ['an already-listed session is skipped', [result('a', 1), result('b', 0.5)], ['a'],
    { costUsd: 0.5, input: 10, output: 20, cacheRead: 300, cacheCreate: 4, sessions: 1, sessionIds: ['b'] }],
  ['every session already listed', [result('a', 1)], ['a'], null],
  ['a torn line is ignored', [result('a', 1), '{"type":"result",'], [],
    { costUsd: 1, input: 10, output: 20, cacheRead: 300, cacheCreate: 4, sessions: 1, sessionIds: ['a'] }],
  ['missing usage counts as zero', [result('a', 2, { usage: undefined })], [],
    { costUsd: 2, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 1, sessionIds: ['a'] }],
];
for (const [name, lines, listed, want] of cases) {
  test(`implementCost: ${name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'tcost-'));
    try {
      const p = join(dir, 'log');
      writeFileSync(p, lines.join('\n'));
      assert.deepEqual(implementCost(p, listed), want);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('implementCost: a missing log is null, and a log larger than one chunk is read whole', () => {
  assert.equal(implementCost('/nonexistent/log'), null);
  const dir = mkdtempSync(join(tmpdir(), 'tcost-'));
  try {
    const p = join(dir, 'log');
    writeFileSync(p, [JSON.stringify({ type: 'assistant', text: 'é'.repeat(200000) }), result('a', 1)].join('\n'));
    assert.equal(implementCost(p).sessions, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
