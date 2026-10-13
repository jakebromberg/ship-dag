// One table, three readers: the digest writer's keep/stamp decision, diagnose-failure's `owningReport` and ingest's `waveWindow`
// (through the warning it gives a stamp that names no report listing the ref) must name the same owner for the same reports.
// Run: node --test "skills/ship-dag/scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineFixture, putReport, RUN } from './lib/engine-fixture.mjs';
import { writeFailureDigests } from './engine/failure-digest.mjs';
import { owningReport } from './diagnose-failure.mjs';
import { ingestWave } from './telemetry.mjs';

const REF = 'WXYC/repo#1';
const W1 = '2026-10-08T19:00:00.000Z';
const W2 = '2026-10-08T20:00:00.000Z';
const row = (over = {}) => ({ ref: REF, number: 1, status: 'skipped', ran: false, ...over });
const rep = (startedAt, rows) => ({ configName: `ship-dag-${RUN}`, startedAt, issues: rows });

// `w1` is in the base dir unless `sibling`; `w2` is always in the base dir and is the report being digested. `owner` is the id every reader must name.
const CASES = {
  'a carried-over row with no digest of its own': { w1: [row()], w2: [row()], owner: 'w1', stamp: 'w1' },
  'a carried-over row with a digest of its own': { w1: [row()], w2: [row()], digest: { reportId: 'w1' }, owner: 'w1', stamp: 'w1' },
  'a ran:false row with a new PR is its own event': { w1: [row({ prNumber: 5 })], w2: [row({ prNumber: 6 })], owner: 'w2', stamp: 'w2' },
  'a ran:false row whose status changed is its own event': { w1: [row()], w2: [row({ status: 'blocked' })], owner: 'w2', stamp: 'w2' },
  'a row carried over from a report in a sibling run-family dir': { w1: [row()], w2: [row()], sibling: true, owner: 'w1', stamp: 'w1' },
  'an errored read with a parseable report and startedAt': { w1: [row({ ran: true })], w2: [row({ ran: true }), { number: 9 }], owner: 'w2', stamp: 'w2', errored: ['w2'] },
};

for (const [name, spec] of Object.entries(CASES)) {
  test(`ownership agreement: ${name}`, async (t) => {
    const fx = engineFixture({ [RUN]: {}, [`${RUN}-b`]: {} });
    t.after(fx.cleanup);
    const base = fx.dirs[RUN];
    putReport(spec.sibling ? fx.dirs[`${RUN}-b`] : base, 'w1.json', rep(W1, spec.w1));
    putReport(base, 'w2.json', rep(W2, spec.w2));
    const digestPath = join(base, 'state', 'failure-digest', 'issue-WXYC%2Frepo%231.json');
    if (spec.digest) { mkdirSync(join(base, 'state', 'failure-digest')); writeFileSync(digestPath, JSON.stringify({ ref: REF, ...spec.digest })); }

    await writeFailureDigests({ configDir: join(base, 'state'), report: rep(W2, spec.w2), reportId: 'w2' });
    assert.equal(JSON.parse(readFileSync(digestPath, 'utf8')).reportId, spec.stamp, 'the writer\'s stamp');
    assert.equal(owningReport(base, REF, { warn: () => {} }).id, spec.owner, 'diagnose-failure\'s owner');

    for (const id of ['w1', 'w2'].filter((i) => !spec.errored?.includes(i))) {
      const warnings = [];
      const dir = id === 'w1' && spec.sibling ? fx.dirs[`${RUN}-b`] : base;
      ingestWave(join(dir, 'state', 'reports', `${id}.json`), {}, { path: join(fx.base, 'telemetry.jsonl'), warn: (m) => warnings.push(m) });
      assert.deepEqual(warnings.filter((m) => /names no report of this run/.test(m)), [], `ingest of ${id} accepts the stamp ${spec.stamp}`);
    }
  });
}

test('ownership agreement: a stamp naming a report that only carries the row over is not accepted by ingest', async (t) => {
  const fx = engineFixture({ [RUN]: {} });
  t.after(fx.cleanup);
  const base = fx.dirs[RUN];
  putReport(base, 'w1.json', rep(W1, [row()]));
  putReport(base, 'w2.json', rep(W2, [row()]));
  mkdirSync(join(base, 'state', 'failure-digest'));
  writeFileSync(join(base, 'state', 'failure-digest', 'issue-WXYC%2Frepo%231.json'), JSON.stringify({ ref: REF, reportId: 'w2' }));
  const warnings = [];
  ingestWave(join(base, 'state', 'reports', 'w1.json'), {}, { path: join(fx.base, 'telemetry.jsonl'), warn: (m) => warnings.push(m) });
  assert.ok(warnings.some((m) => /stamped with report id "w2", which names no report of this run that lists/.test(m)));
});

test('ownership agreement: a stamp naming a report whose ran:false row is its own event is honored (not just a row with ran !== false)', async (t) => {
  const fx = engineFixture({ [RUN]: {} });
  t.after(fx.cleanup);
  const base = fx.dirs[RUN];
  putReport(base, 'w1.json', rep(W1, [row({ prNumber: 5 })]));
  putReport(base, 'w2.json', rep(W2, [row({ prNumber: 6 })]));
  mkdirSync(join(base, 'state', 'failure-digest'));
  writeFileSync(join(base, 'state', 'failure-digest', 'issue-WXYC%2Frepo%231.json'), JSON.stringify({ ref: REF, reportId: 'w2' }));
  const warnings = [];
  ingestWave(join(base, 'state', 'reports', 'w1.json'), {}, { path: join(fx.base, 'telemetry.jsonl'), warn: (m) => warnings.push(m) });
  assert.deepEqual(warnings.filter((m) => /stamped with report id/.test(m)), [], 'w1 reads the w2 stamp as belonging to another wave, with no warning');
});
