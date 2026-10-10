import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWaveEpic, openWaveEpic, closeWaveEpic, qualifyRef } from './wave-epic.mjs';
import { bodyEdges } from '../plan-waves.mjs';

const R = 'o/r';

/**
 * A stateful fake `gh` over one repo's issues: `{ [n]: { title, state, labels,
 * parent, repo? } }`. It answers exactly the calls wave-epic.mjs makes, applies
 * their writes to the state, and throws on anything else, so an unplanned call
 * fails the test. `failMoves` holds issue numbers whose re-parent POST fails.
 */
function fakeGh(issues, { failMoves = [] } = {}) {
  const calls = [];
  const flag = (argv, f) => argv[argv.indexOf(f) + 1];
  const field = (argv, k) => {
    const hit = argv.find((a, i) => (argv[i - 1] === '-f' || argv[i - 1] === '-F') && a.startsWith(`${k}=`));
    return hit && hit.slice(k.length + 1);
  };
  const idOf = (n) => 1000 + Number(n);
  const byId = (id) => Number(id) - 1000;
  const node = (n) => ({
    number: n,
    state: issues[n].state || 'OPEN',
    repository: { nameWithOwner: issues[n].repo || R },
    subIssuesSummary: { total: Object.values(issues).filter((i) => i.parent === n).length },
    labels: { nodes: (issues[n].labels || []).map((name) => ({ name })) },
  });
  const run = (argv) => {
    calls.push(argv);
    const [a, b] = argv;
    if (a === 'api' && b === 'graphql') {
      const n = Number(field(argv, 'n'));
      const kids = Object.keys(issues).map(Number).filter((k) => issues[k].parent === n);
      return JSON.stringify({ data: { repository: { issue: { subIssues: {
        nodes: kids.map(node), pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    }
    if (a === 'api' && argv[1] === '-X' && argv[2] === 'POST') {
      const parent = Number(argv[3].match(/issues\/(\d+)\/sub_issues$/)[1]);
      const child = byId(field(argv, 'sub_issue_id'));
      if (failMoves.includes(child)) throw new Error(`HTTP 422 moving #${child}`);
      if (issues[child].parent != null && field(argv, 'replace_parent') !== 'true') throw new Error('already has a parent');
      issues[child].parent = parent;
      return '{}';
    }
    if (a === 'api' && /^repos\/o\/r\/issues\/\d+$/.test(b) && flag(argv, '--jq') === '.id') {
      return `${idOf(b.split('/').pop())}\n`;
    }
    if (a === 'api' && b === `repos/${R}/issues`) {
      const n = Math.max(...Object.keys(issues).map(Number)) + 1;
      issues[n] = { title: field(argv, 'title'), body: field(argv, 'body'), labels: [field(argv, 'labels[]')], state: 'OPEN' };
      return JSON.stringify({ number: n, id: idOf(n) });
    }
    if (a === 'issue' && b === 'view') {
      const i = issues[Number(argv[2])];
      if (flag(argv, '--jq') === '.title') return `${i.title}\n`;
      return JSON.stringify({ state: i.state || 'OPEN', labels: (i.labels || []).map((name) => ({ name })) });
    }
    if (a === 'issue' && b === 'list') {
      const want = flag(argv, '--search').match(/in:title "(.*)"$/)[1];
      return JSON.stringify(Object.entries(issues)
        .filter(([, i]) => (i.labels || []).includes('ship-dag-wave') && (i.state || 'OPEN') === 'OPEN' && i.title.includes(want))
        .map(([n, i]) => ({ number: Number(n), title: i.title })));
    }
    if (a === 'label' && b === 'create') return '';
    if (a === 'issue' && b === 'comment') { (issues[Number(argv[2])].comments ||= []).push(flag(argv, '--body')); return ''; }
    if (a === 'issue' && b === 'close') { issues[Number(argv[2])].state = 'CLOSED'; return ''; }
    throw new Error(`unexpected gh call: ${argv.join(' ')}`);
  };
  run.calls = calls;
  return run;
}

const WAVE = ['ship-dag-wave'];
const quiet = () => {};

// ---- planWaveEpic ------------------------------------------------------

for (const { name, existingWaveCount, refs, children, wave, move, listed } of [
  { name: 'a direct child moves', existingWaveCount: 0, refs: ['o/r#10'], children: ['o/r#10'], wave: 1, move: ['o/r#10'], listed: [] },
  { name: 'a nested child is listed', existingWaveCount: 0, refs: ['o/r#10', 'o/r#31'], children: ['o/r#10'], wave: 1, move: ['o/r#10'], listed: ['o/r#31'] },
  { name: 'a cross-repo child is listed', existingWaveCount: 0, refs: ['x/y#5'], children: [], wave: 1, move: [], listed: ['x/y#5'] },
  { name: 'numbering continues after 3 waves', existingWaveCount: 3, refs: ['o/r#10'], children: ['o/r#10'], wave: 4, move: ['o/r#10'], listed: [] },
]) {
  test(`planWaveEpic: ${name}`, () => {
    const plan = planWaveEpic({ repo: R, epic: 1, epicTitle: 'Epic', existingWaveCount, refs, epicChildren: new Set(children) });
    assert.equal(plan.wave, wave);
    assert.equal(plan.title, `Epic — wave ${wave}`);
    assert.deepEqual(plan.move, move);
    assert.deepEqual(plan.listed, listed);
    for (const r of refs) assert.ok(plan.body.includes(r.startsWith('o/r#') ? `#${r.split('#')[1]}` : r));
    assert.deepEqual(bodyEdges({ number: 99, repo: R }, plan.body), [], 'the body carries no dependency prose');
  });
}

test('qualifyRef qualifies bare and #N refs, keeps qualified ones, refuses junk', () => {
  assert.equal(qualifyRef('12', R), 'o/r#12');
  assert.equal(qualifyRef('#12', R), 'o/r#12');
  assert.equal(qualifyRef('x/y#3', R), 'x/y#3');
  assert.throws(() => qualifyRef('PR 12', R), /not an issue ref/);
});

// ---- openWaveEpic -----------------------------------------------------

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
  assert.equal(issues[32].parent, 1);
  assert.equal(issues[10].parent, 32);
  assert.equal(issues[11].parent, 32);
  assert.equal(issues[31].parent, 20, 'a nested issue keeps its own parent');
  const posts = gh.calls.filter((c) => c[2] === 'POST').map((c) => `${c[3].match(/issues\/(\d+)/)[1]}<-${c[c.indexOf('-F') + 1]}`);
  assert.deepEqual(posts, ['1<-sub_issue_id=1032', '32<-sub_issue_id=1010', '32<-sub_issue_id=1011'],
    'attach first, then the moves');
});

test('openWaveEpic leaves an issue under the epic when its move fails, and warns', () => {
  const issues = { 1: { title: 'Epic' }, 10: { title: 'a', parent: 1 }, 11: { title: 'b', parent: 1 } };
  const seen = [];
  const out = openWaveEpic({ repo: R, epic: 1, refs: ['10', '11'] }, fakeGh(issues, { failMoves: [11] }), (m) => seen.push(m));
  assert.deepEqual(out.moved, ['o/r#10']);
  assert.deepEqual(out.listed, ['o/r#11']);
  assert.equal(issues[11].parent, 1);
  assert.match(seen[0], /o\/r#11.*stays under #1/);
});

test('openWaveEpic reuses an attached open wave sub-epic that holds one of the refs', () => {
  const issues = {
    1: { title: 'Epic' },
    7: { title: 'Epic — wave 3', labels: WAVE, parent: 1 },
    10: { title: 'a', parent: 7 },
    11: { title: 'b', parent: 1 },
  };
  const gh = fakeGh(issues);
  const out = openWaveEpic({ repo: R, epic: 1, refs: ['10', '11'] }, gh, quiet);
  assert.deepEqual(out, { number: 7, wave: 3, moved: ['o/r#10', 'o/r#11'], listed: [], reused: true });
  assert.equal(issues[11].parent, 7);
  assert.ok(!gh.calls.some((c) => c[1] === `repos/${R}/issues`), 'no second create');
});

test('openWaveEpic reuses an unattached wave sub-epic found by its exact title', () => {
  const issues = {
    1: { title: 'Epic' },
    7: { title: 'Epic — wave 1', labels: WAVE },
    10: { title: 'a', parent: 1 },
  };
  const gh = fakeGh(issues);
  const out = openWaveEpic({ repo: R, epic: 1, refs: ['10'] }, gh, quiet);
  assert.deepEqual(out, { number: 7, wave: 1, moved: ['o/r#10'], listed: [], reused: true });
  assert.equal(issues[7].parent, 1, 'attached now');
  assert.equal(issues[10].parent, 7);
  assert.ok(!gh.calls.some((c) => c[1] === `repos/${R}/issues`), 'no second create');
});

// ---- closeWaveEpic ----------------------------------------------------

for (const { name, wave, kids, failMoves, expect, waveState, parents } of [
  {
    name: 'all children closed: comments and closes',
    wave: { state: 'OPEN' }, kids: { 10: 'CLOSED', 11: 'CLOSED' },
    expect: { closed: true, returned: [], stuck: [], noop: false }, waveState: 'CLOSED', parents: { 10: 7, 11: 7 },
  },
  {
    name: 'an open child goes back to the epic, then the wave closes',
    wave: { state: 'OPEN' }, kids: { 10: 'CLOSED', 11: 'OPEN' },
    expect: { closed: true, returned: ['o/r#11'], stuck: [], noop: false }, waveState: 'CLOSED', parents: { 10: 7, 11: 1 },
  },
  {
    name: 'a failed return leaves the wave open',
    wave: { state: 'OPEN' }, kids: { 10: 'OPEN', 11: 'OPEN' }, failMoves: [11],
    expect: { closed: false, returned: ['o/r#10'], stuck: ['o/r#11'], noop: false }, waveState: 'OPEN', parents: { 10: 1, 11: 7 },
  },
  {
    name: 'an already closed wave with no open child is a no-op',
    wave: { state: 'CLOSED' }, kids: { 10: 'CLOSED' },
    expect: { closed: false, returned: [], stuck: [], noop: true }, waveState: 'CLOSED', parents: { 10: 7 },
  },
]) {
  test(`closeWaveEpic: ${name}`, () => {
    const issues = { 1: { title: 'Epic' }, 7: { title: 'Epic — wave 1', labels: WAVE, parent: 1, ...wave } };
    for (const [n, state] of Object.entries(kids)) issues[n] = { title: `#${n}`, state, parent: 7 };
    const gh = fakeGh(issues, { failMoves });
    const out = closeWaveEpic({ repo: R, epic: 1, waveEpic: 7, outcomes: { 10: { finalState: 'merged', pr: 40 }, '#11': { failureReason: 'review blocked' } } }, gh);
    assert.deepEqual(out, expect);
    assert.equal(issues[7].state, waveState);
    for (const [n, p] of Object.entries(parents)) assert.equal(issues[n].parent, p, `#${n}'s parent`);
    if (expect.noop) {
      assert.equal(issues[7].comments, undefined);
    } else {
      assert.match(issues[7].comments[0], /\| #10 \| (closed|returned to #1) \| #40 \| merged \|/);
      assert.deepEqual(bodyEdges({ number: 7, repo: R }, issues[7].comments[0]), []);
    }
  });
}

test('closeWaveEpic refuses an issue without the wave label', () => {
  const issues = { 1: { title: 'Epic' }, 7: { title: 'not a wave', parent: 1 } };
  const gh = fakeGh(issues);
  assert.throws(() => closeWaveEpic({ repo: R, epic: 1, waveEpic: 7 }, gh), /not labelled ship-dag-wave/);
  assert.equal(gh.calls.length, 1, 'nothing past the label check');
});
