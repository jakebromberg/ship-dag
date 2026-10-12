import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWaveReport, readWaveReports, waveContextFor } from './wave-reports.mjs';
import { SIDECAR_NAME } from './wave-sidecar.mjs';

const REF = 'WXYC/repo#1';
const dirs = [];
const stateDir = () => { const d = mkdtempSync(join(tmpdir(), 'wave-reports-')); dirs.push(d); mkdirSync(join(d, 'state', 'reports'), { recursive: true }); return d; };
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const putReport = (d, id, body) => writeFileSync(join(d, 'state', 'reports', `${id}.json`), typeof body === 'string' ? body : JSON.stringify(body));
const sidecar = (d, ...entries) => writeFileSync(join(d, SIDECAR_NAME), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
const entry = (emittedAt, tuningVersion) => ({ emittedAt, tuningVersion, issues: [{ ref: REF, complexity: 'normal' }] });
const STARTED = '2026-01-02T00:00:00Z';

test('readWaveReports parses each report once and flags the ones a caller must refuse', () => {
  const d = stateDir();
  putReport(d, 'ok', { startedAt: STARTED, issues: [{ ref: REF }] });
  putReport(d, 'torn', '{nope');
  putReport(d, 'no-issues', { startedAt: STARTED });
  putReport(d, 'no-start', { issues: [] });
  putReport(d, 'bad-start', { startedAt: 'soon', issues: [] });
  const warns = [];
  const byId = Object.fromEntries(readWaveReports(d, { warn: (m) => warns.push(m) }).map((r) => [r.id, r]));
  assert.equal(byId.ok.startedAt, Date.parse(STARTED));
  assert.equal(byId.ok.error, undefined);
  assert.match(byId.torn.error, /cannot read the report/);
  assert.match(byId['no-issues'].error, /no issues array/);
  assert.match(byId['no-start'].error, /no parseable startedAt: undefined/);
  assert.match(byId['bad-start'].error, /no parseable startedAt: "soon"/);
  assert.equal(warns.length, 4);
  assert.deepEqual(readWaveReports(join(d, 'missing')), []);
});

test('waveContextFor takes the sidecar entry as of startedAt, never a later re-emit', () => {
  const d = stateDir();
  sidecar(d, entry('2026-01-01T00:00:00Z', 2), entry('2026-01-03T00:00:00Z', 5));
  const ctx = waveContextFor(d, { report: { issues: [{ ref: REF }] }, startedAt: Date.parse(STARTED) }, { warn: () => {} });
  assert.equal(ctx.source, 'sidecar');
  assert.equal(ctx.entry.tuningVersion, 2);
});

test('waveContextFor falls back to the config in the state dir, then state/, and reports none', () => {
  const config = { name: 'ship-dag-run1', defaultEffort: 'high', defaultModel: 'sonnet', issues: [{ repo: 'WXYC/repo', number: 1, complexity: 'normal' }] };
  // A config's mtime is when the test wrote it, so the report starts just after.
  const report = { report: { issues: [{ ref: REF }] }, startedAt: Date.now() + 60_000 };
  const top = stateDir();
  writeFileSync(join(top, 'config.json'), JSON.stringify(config));
  const nested = stateDir();
  writeFileSync(join(nested, 'state', 'config.json'), JSON.stringify(config));
  for (const d of [top, nested]) {
    const ctx = waveContextFor(d, report, { warn: () => {} });
    assert.equal(ctx.source, 'config');
    assert.equal(ctx.entry.tuningVersion, undefined);
    assert.equal(ctx.config.name, 'ship-dag-run1');
  }
  assert.deepEqual(waveContextFor(stateDir(), report, { warn: () => {} }), { entry: null, config: null, source: null });
});

test('readWaveReport reads any path, and keeps the rows of a report whose startedAt does not parse', () => {
  const d = stateDir();
  const path = join(d, 'state', 'reports', 'w1.txt');
  writeFileSync(path, JSON.stringify({ startedAt: 'soon', issues: [{ ref: REF }] }));
  const read = readWaveReport(path);
  assert.deepEqual(read.report.issues, [{ ref: REF }]);
  assert.match(read.error, /no parseable startedAt: "soon"/);
  assert.equal(read.startedAt, undefined);
  assert.match(readWaveReport(join(d, 'gone.json')).error, /cannot read the report: ENOENT/);
});

test('waveContextFor refuses a startedAt that is not epoch ms rather than take the newest entry', () => {
  for (const startedAt of [undefined, NaN, STARTED]) {
    assert.throws(() => waveContextFor(stateDir(), { report: { issues: [{ ref: REF }] }, startedAt }), TypeError);
  }
});

// The ref error wins, but a startedAt that parses still comes back: a later sibling's start bounds a wave's window.
test('readWaveReport refuses a row with no owner/repo#N ref before it looks at startedAt, keeping the report and a parseable startedAt', () => {
  const d = stateDir();
  // A null row has no ref either; it must be refused, not passed through as falsy.
  for (const [id, startedAt, want, bad] of [
    ['bad-ref', STARTED, Date.parse(STARTED), { ref: 'o-r-2', status: 'failed' }],
    ['bad-ref-no-start', undefined, undefined, { ref: 'o-r-2', status: 'failed' }],
    ['null-row', STARTED, Date.parse(STARTED), null],
  ]) {
    putReport(d, id, { startedAt, issues: [{ ref: REF }, bad] });
    const read = readWaveReport(join(d, 'state', 'reports', `${id}.json`));
    assert.equal(read.error, `${read.path}: a row has no owner/repo#N ref: ${JSON.stringify(bad)}`);
    assert.equal(read.report.issues.length, 2);
    assert.equal(read.startedAt, want);
  }
});
