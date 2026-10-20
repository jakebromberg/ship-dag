import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { engineFixture, scopedEngineFixture, stamped, stateRow, stateReport, sidecarEntry, engineConfig, RUN, T0, EMITTED } from './engine-fixture.mjs';
import { readWaveReports, waveContextFor } from './wave-reports.mjs';
import { parseRef } from './ref.mjs';

const REF = 'WXYC/dj-site#1';
const mtime = (path) => statSync(path).mtimeMs / 1000;

test('engineFixture writes each dir\'s reports, sidecar, configs, reviews, digests and files where the engine does, and removes them on cleanup', () => {
  const fx = engineFixture({
    [RUN]: {
      reports: { 'w1.json': stateReport([stateRow(REF)]), 'torn.json': '{nope' },
      sidecar: [sidecarEntry([REF])],
      configs: { 'config.json': engineConfig([REF]), 'state/config-2.json': stamped('2026-10-08T18:00:00.000Z', engineConfig([REF])) },
      reviews: [{ ref: REF, tag: '.r2', findings: [], at: '2026-10-08T19:10:00.000Z' }],
      digests: [{ ref: REF, body: { failureReason: 'x' }, at: '2026-10-08T19:30:00.000Z' }],
      files: { 'state/logs/a.log': 'text' },
    },
    [`${RUN}-b`]: {},
  });
  try {
    const dir = fx.dirs[RUN];
    assert.equal(dir, join(fx.base, RUN));
    assert.deepEqual(readdirSync(join(dir, 'state', 'reports')).sort(), ['torn.json', 'w1.json']);
    assert.equal(readFileSync(join(dir, 'state', 'logs', 'a.log'), 'utf8'), 'text');
    assert.equal(mtime(join(dir, 'config.json')), Date.parse(EMITTED) / 1000);
    assert.equal(mtime(join(dir, 'state', 'config-2.json')), Date.parse('2026-10-08T18:00:00.000Z') / 1000);
    assert.equal(mtime(join(dir, 'reviews', 'WXYC%2Fdj-site%231.r2.json')), Date.parse('2026-10-08T19:10:00.000Z') / 1000);
    assert.ok(existsSync(join(dir, 'state', 'failure-digest')));
    assert.ok(existsSync(join(fx.dirs[`${RUN}-b`], 'state', 'reports')));
    const [good, torn] = readWaveReports(dir, { warn: () => {} }).sort((a, b) => Boolean(a.error) - Boolean(b.error));
    assert.equal(good.startedAt, Date.parse(T0));
    assert.match(torn.error, /cannot read/);
    assert.equal(waveContextFor(dir, good, { warn: () => {} }).source, 'sidecar');
  } finally {
    fx.cleanup();
  }
  assert.ok(!existsSync(fx.base));
});

test('stateRow and engineConfig read their refs through parseRef: a malformed row keeps its ref, a config refuses one', () => {
  assert.deepEqual([stateRow(REF).number, sidecarEntry([REF]).issues[0].ref], [1, REF]);
  assert.deepEqual(engineConfig([REF]).issues, [{ repo: parseRef(REF).repo, number: 1 }]);
  assert.deepEqual([stateRow('dj-site#1').ref, stateRow('dj-site#1').number], ['dj-site#1', null]);
  assert.throws(() => engineConfig(['WXYC/dj-site']), /not an owner\/repo#N ref/);
});

test('engineFixture throws when a sidecar entry could not be written, rather than building a dir without it', () => {
  // A report key that climbs out of state/reports makes the sidecar path a directory before the sidecar is appended.
  assert.throws(() => engineFixture({ [RUN]: { reports: { '../../ship-dag-wave.jsonl/x.json': {} }, sidecar: [sidecarEntry()] } }), /appendWave did not write/);
});

test('stateRow: ran and sessionIds are options, and a row without them is a pre-change row', () => {
  const plain = stateRow(REF);
  assert.deepEqual(['ran' in plain, 'sessionIds' in plain], [false, false]);
  const launched = stateRow(REF, { ran: true, sessionIds: ['a', 'b'] });
  assert.deepEqual([launched.ran, launched.sessionIds], [true, ['a', 'b']]);
  assert.equal(stateRow(REF, { ran: false }).ran, false);
});

test('scopedEngineFixture builds a fixture that is removed when the importing test file finishes', () => {
  const script = `import { scopedEngineFixture } from ${JSON.stringify(new URL('./engine-fixture.mjs', import.meta.url).href)};
    import { test } from 'node:test';
    test('x', () => console.log(scopedEngineFixture({ a: {} }).base));`;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  const base = out.stdout.split('\n').find((l) => l.includes('engine-fixture-'))?.trim();
  assert.ok(base, out.stdout + out.stderr);
  assert.equal(existsSync(base), false);
});
