// Tests for the escaped-defect proxy. Run: node --test "scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escapesDir, cites, findEscapes, withBackoff, escapeReport, mergedPrs } from './escapes.mjs';

const NOW = Date.parse('2026-09-30T00:00:00Z');
const tmp = () => mkdtempSync(join(tmpdir(), 'ship-dag-escapes-'));
const MERGED = '2026-08-01T10:00:00Z';
const PR = { repo: 'o/r', pr: 5, tuningVersion: 1 };

/** A fake gh keyed on subcommand: pr view → details; search prs/issues → canned lists. */
function fakeGh({ prs = [], issues = [], details = {} } = {}) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    if (args[0] === 'pr') return JSON.stringify({ mergedAt: MERGED, title: 'Add thing', commits: [{ oid: 'abc1234def' }], closingIssuesReferences: [{ number: 4 }], ...details });
    if (args[1] === 'issues') return JSON.stringify(issues);
    return JSON.stringify(prs);
  };
  return { gh, calls };
}
const cand = (over) => ({ number: 9, title: 'x', body: '', labels: [], createdAt: '2026-08-10T00:00:00Z', ...over });
const run = (fake, over = {}) => findEscapes([PR], { gh: fake.gh, cacheDir: tmp(), now: NOW, sleep: async () => {}, ...over });

test('escapesDir: env override, XDG, then home', () => {
  assert.equal(escapesDir({ SHIP_DAG_ESCAPES_DIR: '/e', XDG_STATE_HOME: '/x' }), '/e');
  assert.equal(escapesDir({ XDG_STATE_HOME: '/x' }), '/x/ship-dag/escapes');
  assert.equal(escapesDir({ HOME: '/h' }), '/h/.local/state/ship-dag/escapes');
});

test('cites: #N or the PR url, but not #N as a prefix of another number', () => {
  assert.ok(cites('fixes #5', 'o/r', 5));
  assert.ok(cites('see https://github.com/o/r/pull/5', 'o/r', 5));
  assert.ok(!cites('see #55 and #15', 'o/r', 5));
  assert.ok(!cites('see https://github.com/o/other/pull/5', 'o/r', 5));
  assert.ok(!cites(null, 'o/r', 5));
});

test('revert by title', async () => {
  const [r] = await run(fakeGh({ prs: [cand({ number: 20, title: 'Revert "Add thing"' })] }));
  assert.deepEqual(r.escapes.map((e) => [e.number, e.kind]), [[20, 'revert']]);
});

test('revert by body naming a commit of the PR', async () => {
  const [r] = await run(fakeGh({ prs: [cand({ number: 21, title: 'Back it out', body: 'This reverts commit abc1234def0000.' })] }));
  assert.deepEqual(r.escapes.map((e) => [e.number, e.kind]), [[21, 'revert']]);
});

test('a bug-labelled issue citing the PR, or its closing issue', async () => {
  const issues = [cand({ number: 30, body: 'broken since #5', labels: [{ name: 'bug' }] }), cand({ number: 31, body: 'regressed after #4', labels: [{ name: 'bug' }] })];
  const [r] = await run(fakeGh({ issues }));
  assert.deepEqual(r.escapes.map((e) => [e.number, e.kind]), [[30, 'follow-up-fix'], [31, 'follow-up-fix']]);
});

test('a fix PR citing the PR counts; one with no bug signal does not', async () => {
  const prs = [cand({ number: 40, title: 'Fix crash', body: 'follow-up to #5' }), cand({ number: 41, title: 'Add docs', body: 'after #5' })];
  const [r] = await run(fakeGh({ prs }));
  assert.deepEqual(r.escapes.map((e) => e.number), [40]);
});

test('a citation outside the 30-day window, or from an unrelated issue, is not counted', async () => {
  const issues = [
    cand({ number: 50, body: 'broke #5', labels: [{ name: 'bug' }], createdAt: '2026-09-15T00:00:00Z' }),
    cand({ number: 51, body: 'unrelated crash #6', labels: [{ name: 'bug' }] }),
  ];
  const [r] = await run(fakeGh({ issues }));
  assert.deepEqual(r.escapes, []);
});

test('only PRs whose window has closed are counted', async () => {
  const fake = fakeGh();
  assert.deepEqual(await run(fake, { now: Date.parse('2026-08-20T00:00:00Z') }), []);
});

test('candidates are fetched once per repo per window, then cached', async () => {
  const fake = fakeGh();
  const cacheDir = tmp();
  await findEscapes([PR, { ...PR, pr: 6 }], { gh: fake.gh, cacheDir, now: NOW, sleep: async () => {} });
  const searches = () => fake.calls.filter((c) => c[0] === 'search').length;
  assert.equal(searches(), 3);
  await findEscapes([PR], { gh: fake.gh, cacheDir, now: NOW, sleep: async () => {} });
  assert.equal(searches(), 3);
});

test('withBackoff: retries a rate limit with growing waits, then fails naming the repo', async () => {
  const waits = [];
  let n = 0;
  const flaky = async () => { if (++n < 3) throw new Error('HTTP 403: API rate limit exceeded'); return 'ok'; };
  assert.equal(await withBackoff(flaky, { repo: 'o/r', sleep: async (ms) => waits.push(ms) }), 'ok');
  assert.deepEqual(waits, [2000, 4000]);
  const never = async () => { throw new Error('secondary rate limit'); };
  await assert.rejects(withBackoff(never, { repo: 'o/r', retries: 2, sleep: async () => {} }), /o\/r.*rate limit/);
  await assert.rejects(withBackoff(async () => { throw new Error('boom'); }, { repo: 'o/r', sleep: async () => {} }), /boom/);
});

test('escapeReport: rate by merge month and by tuningVersion', () => {
  const rows = [
    { mergedAt: '2026-07-02T00:00:00Z', tuningVersion: 0, escapes: [] },
    { mergedAt: '2026-07-20T00:00:00Z', tuningVersion: 1, escapes: [{ number: 1 }] },
    { mergedAt: '2026-08-02T00:00:00Z', tuningVersion: 1, escapes: [] },
  ];
  const rep = escapeReport(rows);
  assert.deepEqual(rep.total, { prs: 3, escaped: 1, rate: 1 / 3 });
  assert.deepEqual(rep.byMonth['2026-07'], { prs: 2, escaped: 1, rate: 0.5 });
  assert.deepEqual(rep.byTuningVersion['1'], { prs: 2, escaped: 1, rate: 0.5 });
});

test('mergedPrs: merged records with a PR, once each, newest wins; retro and PR-less records skipped', () => {
  const recs = [
    { repo: 'o/r', pr: 5, finalState: 'merged', tuningVersion: 0 },
    { repo: 'o/r', pr: 5, finalState: 'merged', tuningVersion: 2 },
    { repo: 'o/r', pr: null, finalState: 'merged' },
    { repo: 'o/r', pr: 6, finalState: 'error' },
    { kind: 'retro', wave: 1, mergedPrs: [] },
  ];
  assert.deepEqual(mergedPrs(recs), [{ repo: 'o/r', pr: 5, tuningVersion: 2 }]);
});
