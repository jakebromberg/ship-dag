// Tests for the telemetry log's ordering helpers. Run: node --test "scripts/**/*.test.mjs"
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { byTs, latestByRef } from './log-order.mjs';

describe('byTs', () => {
  const [A, B, C] = ['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', '2026-10-03T00:00:00Z'];
  // [name, ts in log order, ts in sorted order]. Records are labelled by log position so ties show their order.
  const table = [
    ['ordered', [A, B, C], [A, B, C]],
    ['reversed', [C, B, A], [A, B, C]],
    ['equal ts keep log order', [B, B, A, B], [A, B, B, B]],
    ['one unparseable ts sorts first', [B, 'garbage', A], ['garbage', A, B]],
    ['several unparseable ts sort first, in log order', [C, 'x', A, undefined, B, 'y'], ['x', undefined, 'y', A, B, C]],
  ];
  for (const [name, input, expected] of table) {
    test(name, () => {
      const records = input.map((ts, i) => ({ ts, i }));
      const sorted = records.toSorted(byTs);
      assert.deepEqual(sorted.map((r) => r.ts), expected);
      if (name.startsWith('equal')) assert.deepEqual(sorted.filter((r) => r.ts === B).map((r) => r.i), [0, 1, 3]);
      if (name.startsWith('several')) assert.deepEqual(sorted.slice(0, 3).map((r) => r.i), [1, 3, 5]);
    });
  }

  test('(a, b) => byTs(b, a) sorts newest first and still keeps equal ts in log order', () => {
    const records = [['2026-10-01T00:00:00Z', 0], ['bad', 1], ['2026-10-03T00:00:00Z', 2], ['2026-10-03T00:00:00Z', 3]].map(([ts, i]) => ({ ts, i }));
    assert.deepEqual(records.toSorted((a, b) => byTs(b, a)).map((r) => r.i), [2, 3, 0, 1]);
  });
});

describe('latestByRef', () => {
  const r = (repo, issue, ts, over = {}) => ({ kind: 'issue', repo, issue, ts, ...over });

  test('holds each ref’s latest record by ts, not by log position, with repo names compared case-insensitively', () => {
    const late = r('Org/Repo', 1, '2026-10-03T00:00:00Z', { finalState: 'merged' });
    const records = [late, r('org/repo', 1, '2026-10-01T00:00:00Z'), r('org/repo', 2, '2026-10-02T00:00:00Z')];
    const latest = latestByRef(records);
    assert.deepEqual([...latest.keys()], ['org/repo#1', 'org/repo#2']);
    assert.equal(latest.get('org/repo#1'), late);
  });

  test('a retro record is ignored, even when it is the newest', () => {
    const issue = r('o/r', 1, '2026-10-01T00:00:00Z');
    const latest = latestByRef([issue, r('o/r', 1, '2026-10-09T00:00:00Z', { kind: 'retro' })]);
    assert.equal(latest.get('o/r#1'), issue);
  });

  test('an unparseable ts loses to a parseable one', () => {
    const good = r('o/r', 1, '2026-10-01T00:00:00Z');
    assert.equal(latestByRef([good, r('o/r', 1, 'garbage')]).get('o/r#1'), good);
  });
});
