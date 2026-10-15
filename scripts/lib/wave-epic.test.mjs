import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { planWaveEpic, openWaveEpic, closeWaveEpic, sweepWaveEpics, qualifyRef, WaveEpicRefusal } from './wave-epic.mjs';
import { WAVE_LABEL } from './sub-issues.mjs';
import { bodyEdges } from '../plan-waves.mjs';
import { graphqlAnswer, graphqlFailure, issueViewNotFound, notFoundBody, restFailure } from './gh-fixture.mjs';

const R = 'o/r';
const WAVE = [WAVE_LABEL];
const quiet = () => {};
const idOf = (n) => 1000 + Number(n);

/**
 * A stateful fake `gh` over one repo's issues: `{ [n]: { title, state, labels,
 * parent, repo? } }`. It answers exactly the calls wave-epic.mjs makes, applies
 * their writes to the state, and throws on anything else, so an unplanned call
 * fails the test. A sub-issue POST without `replace_parent` refuses a child that
 * already has a parent, as GitHub does. A GraphQL query or `issue view` for an
 * issue not in `issues` throws gh's exit 1, as real gh does. `failMoves` holds
 * issue numbers whose POST fails regardless (a REST 422), and `failListings`
 * epics whose sub-issue query fails (a 502).
 */
function fakeGh(issues, { failMoves = [], failListings = [] } = {}) {
  const calls = [];
  const flag = (argv, f) => argv[argv.indexOf(f) + 1];
  const field = (argv, k) => {
    const hit = argv.find((a, i) => (argv[i - 1] === '-f' || argv[i - 1] === '-F') && a.startsWith(`${k}=`));
    return hit && hit.slice(k.length + 1);
  };
  const labelsOf = (i) => (i.labels || []).map((name) => ({ name }));
  const node = (n) => ({
    number: n,
    databaseId: idOf(n),
    title: issues[n].title,
    state: issues[n].state || 'OPEN',
    repository: { nameWithOwner: issues[n].repo || R },
    subIssuesSummary: { total: Object.values(issues).filter((i) => i.parent === n).length },
    labels: { nodes: labelsOf(issues[n]) },
  });
  const run = (argv) => {
    calls.push(argv);
    const [a, b] = argv;
    if (a === 'api' && b === 'graphql') {
      const n = Number(field(argv, 'n'));
      if (field(argv, 'query').includes('subIssues')) {
        if (failListings.includes(n)) throw restFailure(502, `Bad Gateway listing #${n}`, argv);
        if (!issues[n]) throw graphqlFailure(notFoundBody(n), argv);
        const kids = Object.keys(issues).map(Number).filter((k) => issues[k].parent === n);
        return JSON.stringify({ data: { repository: { issue: { subIssues: {
          nodes: kids.map(node), pageInfo: { hasNextPage: false, endCursor: null } } } } } });
      }
      const i = issues[n];
      const p = i && i.parent;
      return graphqlAnswer(i ? { data: { repository: { issue: {
        state: i.state || 'OPEN',
        labels: { nodes: labelsOf(i) },
        parent: p ? { number: p, repository: { nameWithOwner: R } } : null,
      } } } } : notFoundBody(n), argv);
    }
    if (a === 'api' && b === '-X' && argv[2] === 'POST') {
      const parent = Number(argv[3].match(/issues\/(\d+)\/sub_issues$/)[1]);
      const child = Number(field(argv, 'sub_issue_id')) - 1000;
      if (failMoves.includes(child)) throw restFailure(422, `Unprocessable moving #${child}`, argv);
      if (issues[child].parent != null && field(argv, 'replace_parent') !== 'true') throw restFailure(422, 'Unprocessable: already has a parent', argv);
      issues[child].parent = parent;
      return '{}';
    }
    if (a === 'api' && /^repos\/o\/r\/issues\/\d+$/i.test(b) && flag(argv, '--jq') === '.id') return `${idOf(b.split('/').pop())}\n`;
    if (a === 'api' && /^repos\/o\/r\/issues$/i.test(b)) {
      const n = Math.max(...Object.keys(issues).map(Number)) + 1;
      issues[n] = { title: field(argv, 'title'), body: field(argv, 'body'), labels: [field(argv, 'labels[]')], state: 'OPEN' };
      return JSON.stringify({ number: n, id: idOf(n) });
    }
    if (a === 'issue' && b === 'view' && flag(argv, '--jq') === '.title') {
      const i = issues[Number(argv[2])];
      if (!i) throw issueViewNotFound(argv[2], argv);
      return `${i.title}\n`;
    }
    if (a === 'issue' && b === 'list') {
      return JSON.stringify(Object.entries(issues)
        .filter(([, i]) => (i.labels || []).includes(WAVE_LABEL) && (i.state || 'OPEN') === 'OPEN')
        .map(([n, i]) => ({ number: Number(n), title: i.title })));
    }
    if (a === 'label' && b === 'create') return '';
    if (a === 'issue' && b === 'comment') { (issues[Number(argv[2])].comments ||= []).push(flag(argv, '--body')); return ''; }
    if (a === 'issue' && b === 'close') { issues[Number(argv[2])].state = 'CLOSED'; return ''; }
    throw new Error(`unexpected gh call: ${argv.join(' ')}`);
  };
  run.calls = calls;
  run.writes = () => calls.filter((c) => c[2] === 'POST' || c[1] === `repos/${R}/issues`
    || (c[0] === 'issue' && ['comment', 'close'].includes(c[1])) || c[0] === 'label');
  return run;
}

// ---- pure helpers -----------------------------------------------------

for (const { name, refs, movable, move, listed } of [
  { name: 'a direct child moves', refs: ['o/r#10'], movable: ['o/r#10'], move: ['o/r#10'], listed: [] },
  { name: 'a nested child is listed', refs: ['o/r#10', 'o/r#31'], movable: ['o/r#10'], move: ['o/r#10'], listed: ['o/r#31'] },
  { name: 'a cross-repo child is listed', refs: ['x/y#5'], movable: [], move: [], listed: ['x/y#5'] },
  { name: 'refs match case-insensitively', refs: ['O/R#10'], movable: ['o/r#10'], move: ['O/R#10'], listed: [] },
]) {
  test(`planWaveEpic: ${name}`, () => {
    const plan = planWaveEpic({ repo: R, epic: 1, epicTitle: 'Epic', wave: 4, refs, movable: new Set(movable) });
    assert.equal(plan.title, 'Epic — wave 4');
    assert.deepEqual(plan.move, move);
    assert.deepEqual(plan.listed, listed);
    for (const r of listed) assert.ok(plan.body.includes(r.startsWith('x/') ? r : `#${r.split('#')[1]}`));
    assert.deepEqual(bodyEdges({ number: 99, repo: R }, plan.body), [], 'the body carries no dependency prose');
  });
}

for (const [input, expected] of [['12', 'o/r#12'], ['#12', 'o/r#12'], ['x/y#3', 'x/y#3'], ['PR 12', WaveEpicRefusal], ['r#15', WaveEpicRefusal]]) {
  test(`qualifyRef(${JSON.stringify(input)})`, () => {
    if (expected === WaveEpicRefusal) assert.throws(() => qualifyRef(input, R), WaveEpicRefusal);
    else assert.equal(qualifyRef(input, R), expected);
  });
}

// ---- openWaveEpic -----------------------------------------------------

const postsOf = (gh) => gh.calls.filter((c) => c[2] === 'POST').map((c) => `${c[3].match(/issues\/(\d+)/)[1]}<-${Number(c[c.indexOf('-F') + 1].split('=')[1]) - 1000}`);

test('openWaveEpic creates and attaches the sub-epic before moving the epic\'s direct children', () => {
  const issues = {
    1: { title: 'Epic' },
    5: { title: 'Epic — wave 1', labels: WAVE, state: 'CLOSED', parent: 1 },
    10: { title: 'a', parent: 1 },
    11: { title: 'b', parent: 1 },
    20: { title: 'inner epic', parent: 1 },
    31: { title: 'nested', parent: 20 },
  };
  const gh = fakeGh(issues);
  const out = openWaveEpic({ repo: R, epic: 1, refs: ['10', '#11', 'o/r#31'] }, gh, quiet);
  assert.deepEqual(out, { number: 32, wave: 2, moved: ['o/r#10', 'o/r#11'], listed: ['o/r#31'], reused: false });
  assert.equal(issues[32].title, 'Epic — wave 2');
  assert.deepEqual(postsOf(gh), ['1<-32', '32<-10', '32<-11'], 'attach first, then the moves');
  assert.equal(issues[31].parent, 20, 'a nested issue keeps its own parent');
  assert.ok(!gh.calls.some((c) => c[0] === 'api' && /issues\/\d+$/.test(c[1] || '')), 'no per-issue id lookup');
});

test('openWaveEpic leaves an issue under the epic when its move fails, and warns', () => {
  const issues = { 1: { title: 'Epic' }, 10: { title: 'a', parent: 1 }, 11: { title: 'b', parent: 1 } };
  const seen = [];
  const out = openWaveEpic({ repo: R, epic: 1, refs: ['10', '11'] }, fakeGh(issues, { failMoves: [11] }), (m) => seen.push(m));
  assert.deepEqual([out.moved, out.listed], [['o/r#10'], ['o/r#11']]);
  assert.equal(issues[11].parent, 1);
  assert.match(seen[0], /o\/r#11.*keeps its parent/s);
});

test('openWaveEpic reuses an attached wave sub-epic that a crash left empty', () => {
  const issues = { 1: { title: 'Epic' }, 7: { title: 'Epic — wave 2', labels: WAVE, parent: 1 }, 10: { title: 'a', parent: 1 } };
  const gh = fakeGh(issues);
  const out = openWaveEpic({ repo: R, epic: 1, refs: ['10'] }, gh, quiet);
  assert.deepEqual(out, { number: 7, wave: 2, moved: ['o/r#10'], listed: [], reused: true });
  assert.equal(gh.writes().filter((c) => c[1] === `repos/${R}/issues`).length, 0, 'no second create');
});

test('openWaveEpic reuses an unattached wave sub-epic by exact title, skipping one another epic owns', () => {
  const issues = {
    1: { title: 'Epic' },
    2: { title: 'Epic' }, // a second epic with the same title
    6: { title: 'Epic — wave 1', labels: WAVE, parent: 2 },
    7: { title: 'Epic — wave 1', labels: WAVE },
    10: { title: 'a', parent: 1 },
  };
  const gh = fakeGh(issues);
  const out = openWaveEpic({ repo: R, epic: 1, refs: ['10'] }, gh, quiet);
  assert.deepEqual(out, { number: 7, wave: 1, moved: ['o/r#10'], listed: [], reused: true });
  assert.equal(issues[6].parent, 2, 'the other epic keeps its wave');
  assert.equal(issues[7].parent, 1);
});

test('openWaveEpic takes a ref out of a stale open wave into a new one, and never reuses the stale wave', () => {
  const issues = {
    1: { title: 'Epic' },
    7: { title: 'Epic — wave 3', labels: WAVE, parent: 1 }, // left open by a stuck return
    12: { title: 'stuck', parent: 7 },
    13: { title: 'a', parent: 1 },
  };
  const out = openWaveEpic({ repo: R, epic: 1, refs: ['12', '13'] }, fakeGh(issues), quiet);
  assert.deepEqual(out, { number: 14, wave: 4, moved: ['o/r#12', 'o/r#13'], listed: [], reused: false });
  assert.equal(issues[12].parent, 14);
});

test('openWaveEpic matches --repo case-insensitively', () => {
  const issues = { 1: { title: 'Epic' }, 10: { title: 'a', parent: 1 } };
  const out = openWaveEpic({ repo: 'O/R', epic: 1, refs: ['10'] }, fakeGh(issues), quiet);
  assert.deepEqual(out.moved, ['O/R#10']);
  assert.equal(issues[10].parent, 11);
});

// ---- closeWaveEpic ----------------------------------------------------

for (const { name, wave = {}, kids, failMoves, expect, waveState, parents, comments } of [
  {
    name: 'all children closed: comments and closes',
    kids: { 10: 'CLOSED', 11: 'CLOSED' },
    expect: { closed: true, returned: [], stuck: [], noop: false }, waveState: 'CLOSED', parents: { 10: 7, 11: 7 }, comments: 1,
  },
  {
    name: 'an open child goes back to the epic, then the wave closes',
    kids: { 10: 'CLOSED', 11: 'OPEN' },
    expect: { closed: true, returned: ['o/r#11'], stuck: [], noop: false }, waveState: 'CLOSED', parents: { 10: 7, 11: 1 }, comments: 1,
  },
  {
    name: 'a failed return leaves the wave open, and the comment says so',
    kids: { 10: 'OPEN', 11: 'OPEN' }, failMoves: [11],
    expect: { closed: false, returned: ['o/r#10'], stuck: ['o/r#11'], noop: false }, waveState: 'OPEN', parents: { 10: 1, 11: 7 }, comments: 1,
  },
  {
    name: 'only stuck returns: no comment, so a re-run does not repeat one',
    kids: { 11: 'OPEN' }, failMoves: [11],
    expect: { closed: false, returned: [], stuck: ['o/r#11'], noop: false }, waveState: 'OPEN', parents: { 11: 7 }, comments: 0,
  },
  {
    name: 'an already closed wave with no open child is a no-op',
    wave: { state: 'CLOSED' }, kids: { 10: 'CLOSED' },
    expect: { closed: false, returned: [], stuck: [], noop: true }, waveState: 'CLOSED', parents: { 10: 7 }, comments: 0,
  },
]) {
  test(`closeWaveEpic: ${name}`, () => {
    const issues = { 1: { title: 'Epic' }, 7: { title: 'Epic — wave 1', labels: WAVE, parent: 1, ...wave } };
    for (const [n, state] of Object.entries(kids)) issues[n] = { title: `#${n}`, state, parent: 7 };
    const gh = fakeGh(issues, { failMoves });
    const out = closeWaveEpic({ repo: R, epic: 1, waveEpic: 7, outcomes: { 10: { finalState: 'merged', pr: 40 }, '#11': { failureReason: 'review blocked' } } }, gh);
    assert.deepEqual(out, expect);
    assert.equal(issues[7].state || 'OPEN', waveState);
    for (const [n, p] of Object.entries(parents)) assert.equal(issues[n].parent, p, `#${n}'s parent`);
    assert.equal((issues[7].comments || []).length, comments);
    for (const c of issues[7].comments || []) {
      if (kids[10]) assert.match(c, /\| #10 \| (closed|returned to #1) \| #40 \| merged \|/);
      assert.deepEqual(bodyEdges({ number: 7, repo: R }, c), []);
    }
  });
}

for (const { name, issues, outcomes, error } of [
  { name: 'an issue without the wave label', issues: { 7: { title: 'not a wave', parent: 1 } }, error: /not labelled ship-dag-wave/ },
  { name: 'a wave under a different epic', issues: { 2: { title: 'Other' }, 7: { title: 'W', labels: WAVE, parent: 2 } }, error: /not a sub-issue of #1/ },
  { name: 'an outcomes key that is not an issue ref', issues: { 7: { title: 'W', labels: WAVE, parent: 1 } }, outcomes: { 'r#15': {} }, error: /not an issue ref/ },
]) {
  test(`closeWaveEpic refuses ${name}, before any write`, () => {
    const all = { 1: { title: 'Epic' }, 10: { title: '#10', parent: 7 }, ...issues };
    const gh = fakeGh(all);
    assert.throws(() => closeWaveEpic({ repo: R, epic: 1, waveEpic: 7, outcomes }, gh), (err) => err instanceof WaveEpicRefusal && error.test(err.message));
    assert.deepEqual(gh.writes(), []);
    assert.equal(all[10].parent, 7);
  });
}

test('closeWaveEpic refuses a --wave-epic gh cannot find (gh exit 1, NOT_FOUND body), before any write', () => {
  const issues = { 1: { title: 'Epic' }, 10: { title: '#10', parent: 7 } };
  const gh = fakeGh(issues);
  assert.throws(() => closeWaveEpic({ repo: R, epic: 1, waveEpic: 7 }, gh),
    (err) => err instanceof WaveEpicRefusal && /#7 in o\/r could not be read/.test(err.message));
  assert.deepEqual(gh.writes(), []);
});

test('closeWaveEpic lets any other failure reading the wave propagate as itself', () => {
  const err = restFailure(502, 'Bad Gateway');
  assert.throws(() => closeWaveEpic({ repo: R, epic: 1, waveEpic: 7 }, () => { throw err; }), (e) => e === err);
});

// ---- sweepWaveEpics ---------------------------------------------------

for (const { name, waves, except, dryRun, failMoves, failListings, extra = {}, expect, after, writes, note } of [
  {
    name: 'an open wave whose children all closed is closed',
    waves: { 7: { state: 'OPEN', kids: { 10: 'CLOSED' } } },
    expect: { closed: ['o/r#7'], returned: [], stuck: [], errors: [] }, after: { 7: 'CLOSED' }, writes: true, note: /left open/,
  },
  {
    name: 'an open wave with an open child returns it, then closes',
    waves: { 7: { state: 'OPEN', kids: { 10: 'CLOSED', 11: 'OPEN' } } },
    expect: { closed: ['o/r#7'], returned: ['o/r#11'], stuck: [], errors: [] }, after: { 7: 'CLOSED', 11: 1 }, writes: true, note: /left open/,
  },
  {
    name: 'a closed wave with an open child returns it, and says it was closed',
    waves: { 7: { state: 'CLOSED', kids: { 11: 'OPEN' } } },
    expect: { closed: [], returned: ['o/r#11'], stuck: [], errors: [] }, after: { 7: 'CLOSED', 11: 1 }, writes: true, note: /was closed with open issues/,
  },
  {
    name: 'a closed wave whose children all closed costs one listing and no write',
    waves: { 7: { state: 'CLOSED', kids: { 10: 'CLOSED', 12: 'CLOSED' } } },
    expect: { closed: [], returned: [], stuck: [], errors: [] }, after: { 7: 'CLOSED' }, writes: false,
  },
  {
    name: 'a stuck return is reported, the wave stays open, and no comment repeats',
    waves: { 7: { state: 'OPEN', kids: { 11: 'OPEN' } } }, failMoves: [11],
    expect: { closed: [], returned: [], stuck: ['o/r#11'], errors: [] }, after: { 7: 'OPEN', 11: 7 }, writes: true,
  },
  {
    name: 'the wave this pass just opened is left alone',
    waves: { 7: { state: 'OPEN', kids: { 11: 'OPEN' } }, 8: { state: 'OPEN', kids: { 12: 'CLOSED' } } }, except: 7,
    expect: { closed: ['o/r#8'], returned: [], stuck: [], errors: [] }, after: { 7: 'OPEN', 11: 7, 8: 'CLOSED' }, writes: true,
  },
  {
    name: 'one wave failing is reported and the rest still settle',
    waves: { 7: { state: 'OPEN', kids: { 11: 'OPEN' } }, 8: { state: 'OPEN', kids: { 12: 'CLOSED' } } }, failListings: [7],
    expect: { closed: ['o/r#8'], returned: [], stuck: [], errors: [{ wave: 'o/r#7', message: /^Command failed: gh api graphql .*\ngh: Bad Gateway listing #7 \(HTTP 502\)\n$/s }] },
    after: { 7: 'OPEN', 8: 'CLOSED' }, writes: true,
  },
  {
    name: 'a wave sub-issue in another repo is not ours to settle',
    waves: {}, extra: { 9: { title: 'x', labels: WAVE, parent: 1, repo: 'x/y' } },
    expect: { closed: [], returned: [], stuck: [], errors: [] }, after: {}, writes: false,
  },
  {
    name: '--dry-run reports what a clean run would do and writes nothing',
    waves: { 7: { state: 'OPEN', kids: { 10: 'CLOSED', 11: 'OPEN' } }, 8: { state: 'CLOSED', kids: { 12: 'OPEN' } } }, dryRun: true,
    expect: { closed: ['o/r#7'], returned: ['o/r#11', 'o/r#12'], stuck: [], errors: [] }, after: { 7: 'OPEN', 11: 7, 12: 8 }, writes: false,
  },
]) {
  test(`sweepWaveEpics: ${name}`, () => {
    const issues = { 1: { title: 'Epic' }, 30: { title: 'not a wave', parent: 1 }, ...extra };
    for (const [w, { state, kids }] of Object.entries(waves)) {
      issues[w] = { title: `Epic — wave ${w}`, labels: WAVE, state, parent: 1 };
      for (const [n, ks] of Object.entries(kids)) issues[n] = { title: `#${n}`, state: ks, parent: Number(w) };
    }
    const gh = fakeGh(issues, { failMoves, failListings });
    const out = sweepWaveEpics({ repo: R, epic: 1, except, dryRun }, gh);
    // An error's message is gh's whole failure, the full query included, so a row's `message` may be a RegExp.
    const byWave = (r) => ({ ...r, errors: r.errors.map((e) => e.wave) });
    assert.deepEqual(byWave(out), byWave(expect));
    for (const [i, { message }] of expect.errors.entries()) {
      if (message instanceof RegExp) assert.match(out.errors[i].message, message);
      else assert.equal(out.errors[i].message, message);
    }
    for (const [n, v] of Object.entries(after)) {
      if (typeof v === 'number') assert.equal(issues[n].parent, v, `#${n}'s parent`);
      else assert.equal(issues[n].state || 'OPEN', v, `#${n}'s state`);
    }
    assert.equal(gh.writes().length > 0, writes);
    if (!writes && !dryRun) {
      assert.equal(gh.calls.length, 1 + Object.keys(waves).length, 'one listing for the epic and one per wave, nothing else');
    }
    for (const w of Object.keys(waves)) {
      const cs = issues[w].comments || [];
      if (note) assert.match(cs[0], note);
      if (expect.stuck.length) assert.equal(cs.length, 0, 'no comment when every return is stuck');
    }
    assert.equal(issues[30].state || 'OPEN', 'OPEN', 'an unlabelled sub-issue is never touched');
  });
}

// ---- CLI --------------------------------------------------------------

const CLI = fileURLToPath(new URL('../wave-epic.mjs', import.meta.url));
for (const args of [
  ['close', '--repo', R, '--epic', '1', '--wave-epic', '7', '--dry-run'],
  ['open', '--repo', R, '--epic', '1', '--refs', '2', '--dry-run'],
  ['sweep', '--repo', R, '--epic', '1', '--except', 'x'],
  ['close', '--repo', R, '--epic', '1', '--wave-epic', '7', '--outcomes', '{bad'],
  ['sweep', '--repo', 'not-a-repo', '--epic', '1'],
]) {
  test(`the CLI exits 2 before calling gh: ${args.join(' ')}`, () => {
    // An empty PATH makes any gh call fail, so exit 2 here proves nothing ran.
    const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: '' } });
    assert.equal(res.status, 2, res.stderr);
  });
}
