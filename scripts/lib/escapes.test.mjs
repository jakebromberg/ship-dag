// Tests for the escaped-defect proxy. Run: node --test "scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withBackoff } from './gh.mjs';
import { escapesDir, cites, findEscapes, escapeReport, shipDagPrs, CLOSING_PRS_QUERY } from './escapes.mjs';
import { ingestWave } from '../telemetry.mjs';

const NOW = Date.parse('2026-09-30T00:00:00Z');
const tmp = () => mkdtempSync(join(tmpdir(), 'ship-dag-escapes-'));
const MERGED = '2026-08-01T10:00:00Z';
const PR = { repo: 'o/r', pr: 5, tuningVersion: 1 };
const VIEW = 'pr view 5 --repo o/r --json mergedAt,title,commits,closingIssuesReferences';
const closing = (owner, name, number) => ({ number, repository: { name, owner: { login: owner } } });
// GitHub truncates a long commit headline with "…" and carries the rest into the body.
const view = (over) => ({
  mergedAt: MERGED,
  title: 'Add thing',
  commits: [{ oid: 'abc1234def', messageHeadline: 'test(intake): share the auth_user, intake_items and manager-token seeders…', messageBody: '… across the intake specs\n\nMore detail.' }],
  closingIssuesReferences: [closing('o', 'r', 4), closing('o', 'other', 40)],
  ...over,
});
const search = (kind, ...q) => ['search', kind, '--repo', 'o/r', '--created', '2026-08-01..2026-08-31', '--limit', '1000', '--json', 'number,title,body,labels,createdAt', ...q].join(' ');
const SEARCH = {
  revert: search('prs', '--match', 'title', 'Revert'),
  reverts: search('prs', '--match', 'body', 'This reverts commit'),
  fix: search('prs', '--match', 'title', 'fix'),
  regression: search('prs', '--match', 'title', 'regression'),
  bug: search('issues', '--label', 'bug'),
};

/**
 * A fake gh that answers only the exact calls in its table (PR #5's view and its four window searches,
 * empty, unless overridden) and records any other call in `unexpected`. A value may be a function
 * (called per request) and may return an Error, which the call throws.
 */
function fakeGh(routes = {}) {
  const table = { [VIEW]: view(), [SEARCH.revert]: [], [SEARCH.reverts]: [], [SEARCH.fix]: [], [SEARCH.regression]: [], [SEARCH.bug]: [], ...routes };
  const calls = [];
  const unexpected = [];
  const gh = async (args) => {
    const key = args.join(' ');
    calls.push(key);
    if (!Object.hasOwn(table, key)) { unexpected.push(key); throw new Error(`unexpected gh call: ${key}`); }
    const out = typeof table[key] === 'function' ? table[key]() : table[key];
    if (out instanceof Error) throw out;
    return JSON.stringify(out);
  };
  return { gh, calls, unexpected };
}
const cand = (over) => ({ number: 9, title: 'x', body: '', labels: [], createdAt: '2026-08-10T00:00:00Z', ...over });
/** Run findEscapes over `prs` against `fake`, asserting it made no unexpected call; the rows, plus warnings. */
async function run(fake, { prs = [PR], ...over } = {}) {
  const warnings = [];
  const rows = await findEscapes(prs, { gh: fake.gh, cacheDir: tmp(), now: NOW, sleep: async () => {}, warn: (m) => warnings.push(m), ...over });
  assert.deepEqual(fake.unexpected, []);
  return Object.assign(rows, { warnings });
}
const kinds = ([row]) => row.escapes.map((e) => [e.number, e.kind]);

test('escapesDir: env override, XDG, then home', () => {
  assert.equal(escapesDir({ SHIP_DAG_ESCAPES_DIR: '/e', XDG_STATE_HOME: '/x' }), '/e');
  assert.equal(escapesDir({ XDG_STATE_HOME: '/x' }), '/x/ship-dag/escapes');
  assert.equal(escapesDir({ HOME: '/h' }), '/h/.local/state/ship-dag/escapes');
});

for (const [body, repo, n, home, want] of [
  ['fixes #5', 'o/r', 5, 'o/r', true],
  ['regressed by o/r#5', 'o/r', 5, 'o/r', true],
  ['regressed by O/R#5', 'o/r', 5, 'o/r', true],
  ['see https://github.com/o/r/pull/5', 'o/r', 5, 'o/r', true],
  ['see https://github.com/O/R/pull/5#discussion', 'o/r', 5, 'o/r', true],
  ['see https://github.com/o/r/issues/5', 'o/r', 5, 'o/r', true],
  ['see #55 and #15', 'o/r', 5, 'o/r', false],
  ['see o/r#55 and https://github.com/o/r/pull/55', 'o/r', 5, 'o/r', false],
  ['see o/other#5', 'o/r', 5, 'o/r', false],
  ['see xo/r#5', 'o/r', 5, 'o/r', false],
  ['see https://github.com/o/other/pull/5', 'o/r', 5, 'o/r', false],
  [null, 'o/r', 5, 'o/r', false],
  // A cross-repo closing issue is cited only by its qualified reference or URL, never as a bare #N.
  ['broke #40', 'o/other', 40, 'o/r', false],
  ['broke o/other#40', 'o/other', 40, 'o/r', true],
  ['broke https://github.com/o/other/issues/40', 'o/other', 40, 'o/r', true],
  // The repo is escaped before it goes into the RegExp: "." is not a wildcard.
  ['see a/bxc#5', 'a/b.c', 5, 'a/b.c', false],
  ['see a/b.c#5', 'a/b.c', 5, 'a/b.c', true],
]) {
  test(`cites(${JSON.stringify(body)}, ${repo}, ${n}, home ${home}) is ${want}`, () => {
    assert.equal(cites(body, repo, n, home), want);
  });
}

test('the window searches: Revert in the title or "This reverts commit" in the body, fix and regression in the title, bug-labelled issues, over the merge day + 30 days', async () => {
  const fake = fakeGh();
  await run(fake);
  assert.deepEqual(fake.calls, [VIEW, SEARCH.revert, SEARCH.reverts, SEARCH.fix, SEARCH.regression, SEARCH.bug]);
});

for (const [name, title, want] of [
  ['the PR title (the Revert button)', 'Revert "Add thing"', [[20, 'revert']]],
  ['a commit subject, rebuilt from a truncated headline (git revert)', 'Revert "test(intake): share the auth_user, intake_items and manager-token seeders across the intake specs"', [[20, 'revert']]],
  ['a title that only contains the PR title', 'Revert "Add thing twice"', []],
  ['the truncated headline itself', 'Revert "test(intake): share the auth_user, intake_items and manager-token seeders…"', []],
]) {
  test(`revert by title: ${name}`, async () => {
    assert.deepEqual(kinds(await run(fakeGh({ [SEARCH.revert]: [cand({ number: 20, title })] }))), want);
  });
}

test('revert by body: each "This reverts commit <sha>" is resolved to its PRs through GitHub', async () => {
  const sha = '793ac9b8b38b25e20079666b0bbed2737c8ae46b'; // a commit on main, not one of the PR's head commits
  const other = 'f00dfeed';
  const fake = fakeGh({
    // A retitled revert is found only by the body search.
    [SEARCH.reverts]: [cand({ number: 21, title: 'Re-enable label colors', body: `This reverts commit ${sha}.` })],
    [SEARCH.revert]: [cand({ number: 22, title: 'Revert something else', body: `This reverts commit ${other}.` })],
    [`api repos/o/r/commits/${sha}/pulls`]: [{ number: 5 }],
    [`api repos/o/r/commits/${other}/pulls`]: [{ number: 7 }],
  });
  assert.deepEqual(kinds(await run(fake)), [[21, 'revert']]);
});

test('revert by body: a body that names what it reverts decides over a title equal to a (generic) commit subject', async () => {
  const subjectTitle = 'Revert "test(intake): share the auth_user, intake_items and manager-token seeders across the intake specs"';
  const fake = fakeGh({
    [SEARCH.revert]: [cand({ number: 24, title: subjectTitle, body: 'This reverts commit f00dfeed.' }), cand({ number: 25, title: 'Revert "Add thing"', body: 'Reverts o/r#77' })],
    'api repos/o/r/commits/f00dfeed/pulls': [{ number: 7 }],
  });
  assert.deepEqual(kinds(await run(fake)), []);
});

test('revert by body: a sha GitHub cannot resolve is warned about, leaves the title to decide, and leaves the merge day uncached for a later run', async () => {
  const cacheDir = tmp();
  const fake = fakeGh({
    [SEARCH.revert]: [cand({ number: 21, title: 'Revert "Add thing"', body: 'This reverts commit deadbeef.' })],
    'api repos/o/r/commits/deadbeef/pulls': new Error('HTTP 502: Bad Gateway'),
  });
  const rows = await run(fake, { cacheDir });
  assert.deepEqual(kinds(rows), [[21, 'revert']]);
  assert.match(rows.warnings.join('\n'), /o\/r#21.*deadbeef.*Bad Gateway/);
  assert.ok(!existsSync(join(cacheDir, 'v1', 'o__r', '2026-08-01.json')));
});

for (const [body, want] of [
  ['Reverts o/r#5', [[23, 'revert']]],
  ['Reverts O/R#5\n\nWhy: it broke things', [[23, 'revert']]],
  ['Reverts #5', [[23, 'revert']]],
  ['Reverts o/other#5', []],
  ['Reverts #55', []],
  ['This change reverts #5 in part', []],
]) {
  test(`revert by body: ${JSON.stringify(body)}`, async () => {
    assert.deepEqual(kinds(await run(fakeGh({ [SEARCH.revert]: [cand({ number: 23, title: 'Revert "Something"', body })] }))), want);
  });
}

test('a bug-labelled issue citing the PR, or its same-repo closing issue, whatever the label case', async () => {
  const issues = [cand({ number: 30, body: 'broken since #5', labels: [{ name: 'bug' }] }), cand({ number: 31, body: 'regressed after #4', labels: [{ name: 'Bug' }] })];
  assert.deepEqual(kinds(await run(fakeGh({ [SEARCH.bug]: issues }))), [[30, 'follow-up-fix'], [31, 'follow-up-fix']]);
});

test('a cross-repo closing issue counts only when cited by its qualified reference', async () => {
  const issues = [cand({ number: 32, body: 'see #40', labels: [{ name: 'bug' }] }), cand({ number: 33, body: 'see o/other#40', labels: [{ name: 'bug' }] })];
  assert.deepEqual(kinds(await run(fakeGh({ [SEARCH.bug]: issues }))), [[33, 'follow-up-fix']]);
});

test('a fix or regression PR citing the PR counts, by whole word; one without the signal does not', async () => {
  const fixes = [
    cand({ number: 40, title: 'Fix crash', body: 'follow-up to #5' }),
    cand({ number: 41, title: 'Add docs', body: 'after #5' }),
    cand({ number: 42, title: 'prefix-match the typing term', body: 'after #5' }),
    cand({ number: 43, title: 'Fixes the empty state', body: 'after #5' }),
  ];
  const regressions = [cand({ number: 44, title: 'Close a regression in search', body: 'https://github.com/o/r/pull/5' })];
  assert.deepEqual(kinds(await run(fakeGh({ [SEARCH.fix]: fixes, [SEARCH.regression]: regressions }))).map(([n]) => n), [40, 43, 44]);
});

test('a citation outside the 30-day window, or from an unrelated issue, is not counted', async () => {
  const issues = [
    cand({ number: 50, body: 'broke #5', labels: [{ name: 'bug' }], createdAt: '2026-09-15T00:00:00Z' }),
    cand({ number: 51, body: 'unrelated crash #6', labels: [{ name: 'bug' }] }),
  ];
  assert.deepEqual((await run(fakeGh({ [SEARCH.bug]: issues })))[0].escapes, []);
});

test('only merged PRs whose window has closed are counted', async () => {
  assert.equal((await run(fakeGh({ [SEARCH.revert]: new Error('not searched') }), { now: Date.parse('2026-08-20T00:00:00Z') })).length, 0);
  assert.equal((await run(fakeGh({ [VIEW]: view({ mergedAt: null }) }))).length, 0);
});

test('a future now counts, searches and caches only as of the present', async () => {
  const recent = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const fake = fakeGh({ [VIEW]: view({ mergedAt: recent }) });
  assert.equal((await run(fake, { now: Date.parse('2099-01-01T00:00:00Z') })).length, 0);
  assert.deepEqual(fake.calls, [VIEW]);
});

test('candidates are fetched once per repo per merge day, and cached once that day\'s window has closed', async () => {
  const fake = fakeGh({ 'pr view 6 --repo o/r --json mergedAt,title,commits,closingIssuesReferences': view({ mergedAt: '2026-08-01T20:00:00Z' }) });
  const cacheDir = tmp();
  const searches = () => fake.calls.filter((c) => c.startsWith('search')).length;
  await run(fake, { prs: [PR, { ...PR, pr: 6 }], cacheDir });
  assert.equal(searches(), 5);
  await run(fake, { cacheDir });
  assert.equal(searches(), 5);
  assert.ok(existsSync(join(cacheDir, 'v1', 'o__r', '2026-08-01.json')));
});

test('a second run over a settled population makes no gh pr view call: a merged PR\'s view is cached', async () => {
  const cacheDir = tmp();
  await run(fakeGh(), { cacheDir });
  const again = fakeGh();
  const rows = await run(again, { cacheDir });
  assert.deepEqual(again.calls, []);
  assert.deepEqual(kinds(rows), []);
  assert.equal(rows[0].mergedAt, MERGED);
});

test('the view cache is keyed by repo and PR: each PR gets its own view back on a cached run', async () => {
  const cacheDir = tmp();
  const at6 = '2026-08-01T20:00:00Z';
  const atS = '2026-08-01T21:00:00Z';
  const routes = {
    'pr view 6 --repo o/r --json mergedAt,title,commits,closingIssuesReferences': view({ mergedAt: at6 }),
    [VIEW.replace('o/r', 'o/s')]: view({ mergedAt: atS }),
    ...Object.fromEntries(Object.values(SEARCH).map((q) => [q.replace('--repo o/r', '--repo o/s'), []])),
  };
  const prs = [PR, { ...PR, pr: 6 }, { ...PR, repo: 'o/s' }];
  const merges = (rows) => rows.map((r) => `${r.repo}#${r.pr} ${r.mergedAt}`).sort();
  const want = [`o/r#5 ${MERGED}`, `o/r#6 ${at6}`, `o/s#5 ${atS}`];
  assert.deepEqual(merges(await run(fakeGh(routes), { prs, cacheDir })), want);
  const again = fakeGh(routes);
  assert.deepEqual(merges(await run(again, { prs, cacheDir })), want);
  assert.deepEqual(again.calls.filter((c) => c.startsWith('pr view')), []);
});

test('a PR that has not merged is not cached, so a later run asks again', async () => {
  const cacheDir = tmp();
  await run(fakeGh({ [VIEW]: view({ mergedAt: null }) }), { cacheDir });
  const again = fakeGh();
  assert.equal((await run(again, { cacheDir })).length, 1);
  assert.ok(again.calls.includes(VIEW));
});

test('a PR whose cached view is unreadable is viewed again', async () => {
  const cacheDir = tmp();
  mkdirSync(join(cacheDir, 'v1', 'o__r'), { recursive: true });
  writeFileSync(join(cacheDir, 'v1', 'o__r', 'pr-5.json'), '{"merged');
  const fake = fakeGh();
  assert.equal((await run(fake, { cacheDir })).length, 1);
  assert.ok(fake.calls.includes(VIEW));
});

test('revert by body: a sha GitHub reports as unknown (422) falls back to the title and does not block caching the day', async () => {
  const cacheDir = tmp();
  const fake = fakeGh({
    [SEARCH.revert]: [cand({ number: 21, title: 'Revert "Add thing"', body: 'This reverts commit deadbeef.' })],
    'api repos/o/r/commits/deadbeef/pulls': new Error('gh: No commit found for SHA: deadbeef (HTTP 422)'),
  });
  assert.deepEqual(kinds(await run(fake, { cacheDir })), [[21, 'revert']]);
  assert.ok(existsSync(join(cacheDir, 'v1', 'o__r', '2026-08-01.json')));
  const again = fakeGh();
  assert.deepEqual(kinds(await run(again, { cacheDir })), [[21, 'revert']]);
  assert.deepEqual(again.calls, []);
});

for (const order of [['deadbeef', 'cafef00d'], ['cafef00d', 'deadbeef']]) {
  test(`revert by body: a transient sha failure keeps the day uncached whichever side of an unknown (422) sha it is on (${order.join(' then ')})`, async () => {
    const cacheDir = tmp();
    const fake = fakeGh({
      [SEARCH.revert]: [cand({ number: 21, title: 'Revert "Add thing"', body: order.map((sha) => `This reverts commit ${sha}.`).join('\n') })],
      'api repos/o/r/commits/deadbeef/pulls': new Error('HTTP 502: Bad Gateway'),
      'api repos/o/r/commits/cafef00d/pulls': new Error('gh: No commit found for SHA: cafef00d (HTTP 422)'),
    });
    assert.deepEqual(kinds(await run(fake, { cacheDir })), [[21, 'revert']]);
    assert.ok(!existsSync(join(cacheDir, 'v1', 'o__r', '2026-08-01.json')));
  });
}

test('an unreadable cache file is warned about and searched again, not fatal', async () => {
  const cacheDir = tmp();
  mkdirSync(join(cacheDir, 'v1', 'o__r'), { recursive: true });
  writeFileSync(join(cacheDir, 'v1', 'o__r', '2026-08-01.json'), '[{"number": 4');
  const fake = fakeGh({ [SEARCH.bug]: [cand({ number: 30, body: 'broken since #5', labels: [{ name: 'bug' }] })] });
  const rows = await run(fake, { cacheDir });
  assert.deepEqual(kinds(rows), [[30, 'follow-up-fix']]);
  assert.match(rows.warnings.join('\n'), /2026-08-01\.json.*unreadable/);
});

test('a PR whose window has closed is counted, but its merge day is not cached until every window keyed to it has', async () => {
  const fake = fakeGh();
  const cacheDir = tmp();
  const now = Date.parse('2026-08-31T12:00:00Z'); // #5's window closed at 10:00; the day's closes at 2026-09-01T00:00
  assert.equal((await run(fake, { cacheDir, now })).length, 1);
  assert.ok(!existsSync(join(cacheDir, 'v1', 'o__r', '2026-08-01.json')));
  await run(fake, { cacheDir, now });
  assert.equal(fake.calls.filter((c) => c.startsWith('search')).length, 10);
});

test('a merge day is cached only a settling day after its window closes, so late-indexed candidates are not frozen out', async () => {
  const cacheDir = tmp();
  await run(fakeGh(), { cacheDir, now: Date.parse('2026-09-01T12:00:00Z') });
  assert.ok(!existsSync(join(cacheDir, 'v1', 'o__r', '2026-08-01.json')));
  await run(fakeGh(), { cacheDir, now: Date.parse('2026-09-02T00:00:00Z') });
  assert.ok(existsSync(join(cacheDir, 'v1', 'o__r', '2026-08-01.json')));
});

test('a search that reaches GitHub\'s 1000-result cap fails naming the repo and query, and caches nothing', async () => {
  const cacheDir = tmp();
  const full = Array.from({ length: 1000 }, (_, i) => cand({ number: 1000 + i }));
  await assert.rejects(run(fakeGh({ [SEARCH.fix]: full }), { cacheDir }), /o\/r: gh search prs --match title fix --created 2026-08-01\.\.2026-08-31 .*1000/);
  assert.ok(!existsSync(join(cacheDir, 'v1', 'o__r', '2026-08-01.json')));
});

test('a rate-limited search is retried through findEscapes, with growing waits', async () => {
  let n = 0;
  const waits = [];
  const fake = fakeGh({ [SEARCH.fix]: () => (++n < 3 ? new Error('HTTP 403: API rate limit exceeded') : [cand({ number: 40, title: 'Fix crash', body: '#5' })]) });
  const rows = await run(fake, { sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(kinds(rows), [[40, 'follow-up-fix']]);
  assert.deepEqual(waits, [2000, 4000]);
});

test('a PR GitHub cannot show is warned about and skipped; the rest are still reported', async () => {
  const fake = fakeGh({ 'pr view 6 --repo o/r --json mergedAt,title,commits,closingIssuesReferences': new Error('GraphQL: Could not resolve to a PullRequest with the number of 6.') });
  const rows = await run(fake, { prs: [{ ...PR, pr: 6 }, PR] });
  assert.deepEqual(rows.map((r) => r.pr), [5]);
  assert.match(rows.warnings.join('\n'), /o\/r#6.*Could not resolve/);
});

test('a rate limit that outlasts the backoff on a PR view fails the run, naming the repo', async () => {
  const fake = fakeGh({ [VIEW]: new Error('API rate limit exceeded') });
  await assert.rejects(run(fake), /o\/r.*rate limit/);
});

test('withBackoff: retries a rate limit with growing waits, then fails naming the repo', async () => {
  const waits = [];
  let n = 0;
  const flaky = async () => { if (++n < 3) throw new Error('HTTP 403: API rate limit exceeded'); return 'ok'; };
  assert.equal(await withBackoff(flaky, { repo: 'o/r', sleep: async (ms) => waits.push(ms) }), 'ok');
  assert.deepEqual(waits, [2000, 4000]);
  const never = async () => { throw new Error('secondary rate limit'); };
  await assert.rejects(withBackoff(never, { repo: 'o/r', retries: 2, sleep: async () => {} }), /o\/r.*rate limit/);
  // By default it waits out about a minute, the span of GitHub's search limit, before giving up.
  waits.length = 0;
  await assert.rejects(withBackoff(never, { repo: 'o/r', sleep: async (ms) => waits.push(ms) }), /after 5 retries/);
  assert.deepEqual(waits, [2000, 4000, 8000, 16000, 32000]);
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

/** An engine base dir holding one run: its report rows and its sidecar entries. */
function engineDir(rows, entries) {
  const base = tmp();
  mkdirSync(join(base, 'sd-1', 'state', 'reports'), { recursive: true });
  writeFileSync(join(base, 'sd-1', 'state', 'reports', 'r.json'), JSON.stringify({ startedAt: '2026-08-01T00:00:00Z', issues: rows }));
  writeFileSync(join(base, 'sd-1', 'ship-dag-wave.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n'));
  return base;
}
const closers = (repo, n) => `api graphql -f query=${CLOSING_PRS_QUERY} -f owner=${repo.split('/')[0]} -f name=${repo.split('/')[1]} -F n=${n}`;
test('CLOSING_PRS_QUERY asks for the issue\'s state, which decides whether its answer is cached', () => {
  assert.match(CLOSING_PRS_QUERY, /issue\(number:\$n\)\{state /);
});
const closersOf = (...nodes) => ({ data: { repository: { issue: { state: 'CLOSED', closedByPullRequestsReferences: { nodes } } } } });
const openWith = (res) => ({ data: { repository: { issue: { ...res.data.repository.issue, state: 'OPEN' } } } });
const byKey = (prs) => prs.toSorted((a, b) => `${a.repo}#${a.pr}`.localeCompare(`${b.repo}#${b.pr}`));

test('shipDagPrs: telemetry pr fields (an integer or a PR URL; newest record wins; any finalState), then engine report rows', async () => {
  const records = [
    { repo: 'o/r', issue: 9, pr: 5, finalState: 'merged', tuningVersion: 0 },
    { repo: 'o/r', issue: 9, pr: 5, finalState: 'merged', tuningVersion: 2 },
    { repo: 'o/r', issue: 8, pr: 'https://github.com/o/r2/pull/12', finalState: 'merged' },
    { repo: 'o/r', issue: 1, pr: 11, finalState: 'merged', tuningVersion: 1 },
    { repo: 'o/r', issue: 7, pr: null, finalState: 'merged' },
    { repo: 'o/r', issue: 6, pr: 6, finalState: 'error' },
    { kind: 'retro', wave: 1, mergedPrs: [] },
  ];
  const base = engineDir(
    [{ ref: 'O/R#1', status: 'succeeded', prNumber: 11 }, { ref: 'o/r#3', status: 'succeeded', prNumber: 13 }, { ref: 'o/r#2', status: 'failed' }],
    // As ingest-wave reads it: the newest entry with the report's exact ref set, emitted by the time it started.
    [
      { tuningVersion: 3, emittedAt: '2026-07-31T00:00:00Z', issues: [{ ref: 'O/R#1' }, { ref: 'o/r#3' }, { ref: 'o/r#2' }] },
      { tuningVersion: 5, emittedAt: '2026-07-31T12:00:00Z', issues: [{ ref: 'o/r#3' }, { ref: 'o/r#2' }] },
      { tuningVersion: 4, emittedAt: '2026-08-02T00:00:00Z', issues: [{ ref: 'O/R#1' }, { ref: 'o/r#3' }, { ref: 'o/r#2' }] },
    ],
  );
  const fake = fakeGh({ [closers('o/r', 2)]: closersOf() });
  const warnings = [];
  const prs = await shipDagPrs(records, { baseDir: base, cacheDir: tmp(), gh: fake.gh, sleep: async () => {}, warn: (m) => warnings.push(m) });
  assert.deepEqual(byKey(prs), [
    { repo: 'o/r', pr: 11, tuningVersion: 1 },
    { repo: 'o/r', pr: 13, tuningVersion: 3 },
    { repo: 'o/r', pr: 5, tuningVersion: 2 },
    { repo: 'o/r', pr: 6, tuningVersion: 0 },
    { repo: 'o/r2', pr: 12, tuningVersion: 0 },
  ]);
  assert.deepEqual(fake.calls, [closers('o/r', 2)]); // o/r#2 has no PR from either source
  assert.deepEqual(fake.unexpected, []);
});

test('shipDagPrs: a report with no parseable startedAt is skipped with a warning, not given the newest sidecar entry', async () => {
  const base = engineDir([{ ref: 'o/r#1', status: 'succeeded', prNumber: 11 }], [
    { tuningVersion: 4, emittedAt: '2026-08-02T00:00:00Z', issues: [{ ref: 'o/r#1' }, { ref: 'o/r#2' }] },
  ]);
  writeFileSync(join(base, 'sd-1', 'state', 'reports', 'r.json'), JSON.stringify({ issues: [{ ref: 'o/r#1', status: 'succeeded', prNumber: 11 }, { ref: 'o/r#2', status: 'failed' }] }));
  const warnings = [];
  const closer = (number) => closersOf({ number, headRefName: 'orchestrator/x', mergedAt: MERGED, repository: { nameWithOwner: 'o/r' } });
  // GitHub would offer the report's own PR as #1's closer; the skipped report's PR must not come back through it.
  // #2 had no PR in that report, so it falls back as any PR-less row does (a later wave may have opened one).
  const fake = fakeGh({ [closers('o/r', 1)]: closer(11), [closers('o/r', 2)]: closer(22) });
  const prs = await shipDagPrs([], { baseDir: base, cacheDir: tmp(), gh: fake.gh, sleep: async () => {}, warn: (m) => warnings.push(m) });
  assert.deepEqual(prs, [{ repo: 'o/r', pr: 22, tuningVersion: 4 }]);
  assert.deepEqual(fake.calls, [closers('o/r', 2)]);
  assert.ok(warnings.some((m) => /no parseable startedAt.*skipped/.test(m)), warnings.join('\n'));
});

test('shipDagPrs and ingest-wave read one state dir alike: a PR and its tuningVersion from each report ingest-wave records (a pre-sidecar one at 0), none from one it refuses', async () => {
  const row = (n) => ({ ref: `o/r#${n}`, number: n, status: 'succeeded', prNumber: 10 + n });
  const entry = (n, tuningVersion, emittedAt) => ({ runId: 'sd-1', wave: 1, tuningVersion, emittedAt, issues: [{ ref: `o/r#${n}`, complexity: 'normal' }] });
  // #1's wave ran under v2 (v4 is a later re-emit); #2's report has no startedAt, so the newest entry (v4) is not its routing either.
  const base = engineDir([row(1)], [entry(1, 2, '2026-07-31T00:00:00Z'), entry(1, 4, '2026-08-02T00:00:00Z'), entry(2, 4, '2026-08-02T00:00:00Z'), entry(4, 4, '2026-08-02T00:00:00Z')]);
  const reports = join(base, 'sd-1', 'state', 'reports');
  writeFileSync(join(reports, 'r.json'), JSON.stringify({ configName: 'ship-dag-sd-1', startedAt: '2026-08-01T00:00:00Z', issues: [row(1)] }));
  writeFileSync(join(reports, 'r2.json'), JSON.stringify({ configName: 'ship-dag-sd-1', issues: [row(2)] }));
  // #3's wave predates the sidecar: only a config emitted before it started routes it.
  writeFileSync(join(reports, 'r3.json'), JSON.stringify({ configName: 'ship-dag-sd-1', startedAt: '2026-08-01T00:00:00Z', issues: [row(3)] }));
  // #4's report has a row with no owner/repo#N ref: ingest-wave refuses it, so none of its rows gives a PR (nor falls back to a closer).
  writeFileSync(join(reports, 'r4.json'), JSON.stringify({ configName: 'ship-dag-sd-1', startedAt: '2026-08-01T00:00:00Z', issues: [row(4), { ref: 'o-r-5', status: 'failed' }] }));
  const config = join(base, 'sd-1', 'config.json');
  writeFileSync(config, JSON.stringify({ name: 'ship-dag-sd-1', issues: [{ repo: 'o/r', number: 3, complexity: 'normal' }] }));
  utimesSync(config, new Date('2026-07-31T00:00:00Z'), new Date('2026-07-31T00:00:00Z'));
  const ingested = [];
  for (const name of ['r.json', 'r2.json', 'r3.json', 'r4.json']) {
    try { ingested.push(...ingestWave(join(reports, name), {}, { path: join(base, 'log.jsonl'), warn: () => {} }).records); } catch (err) { assert.equal(err.code, 3, err.message); }
  }
  const closer = { number: 12, headRefName: 'orchestrator/two', mergedAt: MERGED, repository: { nameWithOwner: 'o/r' } };
  const closer4 = { ...closer, number: 14, headRefName: 'orchestrator/four' };
  const prs = await shipDagPrs([], { baseDir: base, cacheDir: tmp(), gh: fakeGh({ [closers('o/r', 2)]: closersOf(closer), [closers('o/r', 4)]: closersOf(closer4) }).gh, sleep: async () => {}, warn: () => {} });
  assert.deepEqual(byKey(prs), byKey(ingested.map(({ repo, pr, tuningVersion }) => ({ repo, pr, tuningVersion }))));
  assert.deepEqual(byKey(prs), [{ repo: 'o/r', pr: 11, tuningVersion: 2 }, { repo: 'o/r', pr: 13, tuningVersion: 0 }]);
});

test('shipDagPrs: a sidecar ref with no PR from either source falls back to its one merged orchestrator/ closing PR, under its newest entry\'s version', async () => {
  const base = engineDir([{ ref: 'o/r#1', status: 'failed' }], [
    { tuningVersion: 2, emittedAt: '2026-07-31T00:00:00Z', issues: [{ ref: 'o/r#1' }, { ref: 'o/r#2' }, { ref: 'o/r#3' }, { ref: 'o/r#4' }, { ref: 'o/r#6' }] },
    { tuningVersion: 3, emittedAt: '2026-08-02T00:00:00Z', issues: [{ ref: 'o/r#1' }] },
  ]);
  // An older run dir, listed after sd-1 by name, holds the oldest emit of o/r#1.
  mkdirSync(join(base, 'zz-old'));
  writeFileSync(join(base, 'zz-old', 'ship-dag-wave.jsonl'), JSON.stringify({ tuningVersion: 1, emittedAt: '2026-07-01T00:00:00Z', issues: [{ ref: 'o/r#1' }] }));
  const merged = (number, headRefName) => ({ number, headRefName, mergedAt: MERGED, repository: { nameWithOwner: 'o/r' } });
  const fake = fakeGh({
    [closers('o/r', 1)]: closersOf(merged(21, 'orchestrator/one'), { ...merged(22, 'orchestrator/one-retry'), mergedAt: null }),
    [closers('o/r', 2)]: closersOf(merged(23, 'orchestrator/a'), merged(24, 'orchestrator/b')),
    [closers('o/r', 3)]: closersOf(merged(25, 'feature/hand-made')),
    [closers('o/r', 4)]: new Error('GraphQL: Could not resolve to an Issue with the number of 4.'),
  });
  const warnings = [];
  const records = [{ repo: 'o/r', issue: 6, pr: 60, finalState: 'merged' }];
  const prs = await shipDagPrs(records, { baseDir: base, cacheDir: tmp(), gh: fake.gh, sleep: async () => {}, warn: (m) => warnings.push(m) });
  assert.deepEqual(byKey(prs), [{ repo: 'o/r', pr: 21, tuningVersion: 3 }, { repo: 'o/r', pr: 60, tuningVersion: 0 }]);
  assert.deepEqual(fake.unexpected, []);
  assert.equal(fake.calls.length, 4);
  assert.match(warnings.join('\n'), /o\/r#2: 2 merged orchestrator\/ PRs/);
  assert.match(warnings.join('\n'), /o\/r#3: 0 merged orchestrator\/ PRs/);
  assert.match(warnings.join('\n'), /o\/r#4.*Could not resolve/);
});

test('shipDagPrs: a closed ref\'s one merged closing PR is cached; an open, ambiguous or missing one is asked about again', async () => {
  const base = engineDir([], [{ tuningVersion: 2, emittedAt: '2026-07-31T00:00:00Z', issues: [{ ref: 'o/r#1' }, { ref: 'o/r#2' }, { ref: 'o/r#3' }] }]);
  const cacheDir = tmp();
  const merged = (number) => ({ number, headRefName: 'orchestrator/x', mergedAt: MERGED, repository: { nameWithOwner: 'o/r' } });
  // o/r#3 is open, so a later closing PR could still make its answer "several".
  const routes = { [closers('o/r', 1)]: closersOf(merged(21)), [closers('o/r', 2)]: closersOf(), [closers('o/r', 3)]: openWith(closersOf(merged(31))) };
  const go = async (fake) => byKey(await shipDagPrs([], { baseDir: base, gh: fake.gh, cacheDir, sleep: async () => {}, warn: () => {} }));
  const want = [{ repo: 'o/r', pr: 21, tuningVersion: 2 }, { repo: 'o/r', pr: 31, tuningVersion: 2 }];
  const first = fakeGh(routes);
  assert.deepEqual(await go(first), want);
  const again = fakeGh(routes);
  assert.deepEqual(await go(again), want);
  assert.deepEqual(again.calls, [closers('o/r', 2), closers('o/r', 3)]);
});

test('shipDagPrs: a missing engine dir contributes nothing', async () => {
  const prs = await shipDagPrs([{ repo: 'o/r', issue: 9, pr: 5, finalState: 'merged' }], { baseDir: join(tmp(), 'absent'), cacheDir: tmp(), gh: fakeGh().gh });
  assert.deepEqual(prs, [{ repo: 'o/r', pr: 5, tuningVersion: 0 }]);
});
