import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRunFamilyReports, readWaveReport, readWaveReports, reportOwnership, runFamilyDirs, waveContextFor } from './wave-reports.mjs';
import { appendWave } from './wave-sidecar.mjs';
import { scopedEngineFixture, putReport } from './engine-fixture.mjs';

const REF = 'WXYC/repo#1';
const stateDir = (spec = {}) => scopedEngineFixture({ 'wave-reports': spec }).dirs['wave-reports'];
const put = (d, id, body) => putReport(d, `${id}.json`, body);
const sidecar = (d, ...entries) => entries.forEach((e) => appendWave(d, e));
const entry = (emittedAt, tuningVersion) => ({ emittedAt, tuningVersion, issues: [{ ref: REF, complexity: 'normal' }] });
const STARTED = '2026-01-02T00:00:00Z';

test('readWaveReports parses each report once and flags the ones a caller must refuse', () => {
  const d = stateDir();
  put(d, 'ok', { startedAt: STARTED, issues: [{ ref: REF }] });
  put(d, 'torn', '{nope');
  put(d, 'no-issues', { startedAt: STARTED });
  put(d, 'no-start', { issues: [] });
  put(d, 'bad-start', { startedAt: 'soon', issues: [] });
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
  // The fixture emits each config at EMITTED, so a report starting now is after it.
  const report = { report: { issues: [{ ref: REF }] }, startedAt: Date.now() + 60_000 };
  const top = stateDir({ configs: { 'config.json': config } });
  const nested = stateDir({ configs: { 'state/config.json': config } });
  for (const d of [top, nested]) {
    const ctx = waveContextFor(d, report, { warn: () => {} });
    assert.equal(ctx.source, 'config');
    assert.equal(ctx.entry.tuningVersion, undefined);
    assert.equal(ctx.config.name, 'ship-dag-run1');
    assert.equal(ctx.configFile, join(d, ...(d === nested ? ['state'] : []), 'config.json'));
    assert.equal(ctx.config.configFile, ctx.configFile);
  }
  assert.deepEqual(waveContextFor(stateDir(), report, { warn: () => {} }), { entry: null, config: null, configFile: null, source: null });
});

test('readWaveReport reads any path, and keeps the rows of a report whose startedAt does not parse', () => {
  const d = stateDir({ files: { 'state/reports/w1.txt': { startedAt: 'soon', issues: [{ ref: REF }] } } });
  const path = join(d, 'state', 'reports', 'w1.txt');
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
    put(d, id, { startedAt, issues: [{ ref: REF }, bad] });
    const read = readWaveReport(join(d, 'state', 'reports', `${id}.json`));
    assert.equal(read.error, `${read.path}: a row has no owner/repo#N ref: ${JSON.stringify(bad)}`);
    assert.equal(read.report.issues.length, 2);
    assert.equal(read.startedAt, want);
  }
});

test('runFamilyDirs lists the dirs under baseDir that sameRun the run id: a -b retry folds in, a -board dir and a plain file do not; a base dir it cannot list throws', () => {
  const base = stateDir();
  for (const name of ['sd-1', 'sd-1-b', 'sd-1-w2', 'SD-1-r2', 'sd-1-board', 'sd-2']) mkdirSync(join(base, name));
  writeFileSync(join(base, 'sd-1-c'), '');
  assert.deepEqual(runFamilyDirs('sd-1', base), ['SD-1-r2', 'sd-1', 'sd-1-b', 'sd-1-w2'].map((n) => join(base, n)));
  assert.deepEqual(runFamilyDirs('sd-1', join(base, 'missing')), []);
  assert.throws(() => runFamilyDirs('sd-1', join(base, 'sd-1-c')), { code: 'ENOTDIR' }, 'only a missing base dir reads as none');
});

const row = (over = {}) => ({ ref: REF, status: 'skipped', ran: false, ...over });
const reads = (...specs) => specs.map(([id, startedAt, rows, extra]) => ({ id, path: `/${id}.json`, report: { startedAt, issues: rows }, startedAt: Date.parse(startedAt), ...extra }));
const D1 = '2026-10-01T00:00:00Z';
const D2 = '2026-10-02T00:00:00Z';
const D3 = '2026-10-03T00:00:00Z';

test('reportOwnership: earlierOf is each report\'s earlier parsed reports, computed once per report', () => {
  const [w1, w2, w3] = reads(['w1', D1, [row()]], ['w2', D2, [row()]], ['w3', D3, [row()]]);
  const own = reportOwnership([w3, w1, w2, { id: 'torn', path: '/torn.json', error: 'cannot read' }, { ...w1, id: 'nostart', startedAt: undefined }]);
  assert.deepEqual(own.earlierOf(w3).map((r) => r.startedAt), [D1, D2]);
  assert.equal(own.earlierOf(w3), own.earlierOf(w3));
  assert.deepEqual(own.earlierOf(w1), []);
});

// Each case: the reports (oldest first), and the owner of REF (its id, or null).
const OWNER_CASES = {
  'a row that carries the earlier one over is not its report\'s own event': [[['w1', D1, [row()]], ['w2', D2, [row()]]], 'w1'],
  'a ran:false row with a new PR is its own event': [[['w1', D1, [row({ prNumber: 5 })]], ['w2', D2, [row({ prNumber: 6 })]]], 'w2'],
  'a ran:false row whose status changed is its own event': [[['w1', D1, [row()]], ['w2', D2, [row({ status: 'pending' })]]], 'w2'],
  'a report that lists other refs does not disown it': [[['w1', D1, [row()]], ['w2', D2, [row({ ref: 'o/r#2' })]]], 'w1'],
  'a read with a report and a startedAt counts whatever its error': [[['w1', D1, [row({ ran: true })]], ['w2', D2, [row({ ran: true })], { error: 'a row has no ref' }]], 'w2'],
  'a read with no parseable startedAt never owns': [[['w1', D1, [row({ ran: true })]], ['w2', D2, [row({ ran: true })], { startedAt: undefined }]], 'w1'],
  'no report lists the ref': [[['w1', D1, [row({ ref: 'o/r#2' })]]], null],
};
for (const [name, [specs, id]] of Object.entries(OWNER_CASES)) {
  test(`reportOwnership: ownerOf, ${name}`, () => {
    const all = reads(...specs);
    const own = reportOwnership([...all].reverse());
    assert.equal(own.ownerOf(REF)?.id ?? null, id);
    if (id) assert.equal(own.ownerOf(REF).row.ref, REF);
  });
}

test('reportOwnership: ownerOf breaks a startedAt tie by id, and owns is the negation of carriedOver by earlierOf', () => {
  const [a, b] = reads(['a', D1, [row({ ran: true })]], ['b', D1, [row({ ran: true })]]);
  assert.equal(reportOwnership([b, a]).ownerOf(REF).id, 'b');
  const [w1, w2] = reads(['w1', D1, [row()]], ['w2', D2, [row()]]);
  const own = reportOwnership([w1, w2]);
  assert.equal(own.owns(w1, w1.report.issues[0]), true);
  assert.equal(own.owns(w2, w2.report.issues[0]), false);
});

test('readRunFamilyReports: the reports of every dir of the state dir\'s run family, once each, however the dir is spelled', () => {
  const fx = scopedEngineFixture({ 'sd-1': {}, 'sd-1-b': {}, 'sd-1-board': {}, 'sd-2': {} });
  for (const [d, id] of [['sd-1', 'w1'], ['sd-1-b', 'w2'], ['sd-1-board', 'w3'], ['sd-2', 'w4']]) put(fx.dirs[d], id, { startedAt: STARTED, issues: [] });
  assert.deepEqual(readRunFamilyReports(fx.dirs['sd-1-b'], { warn: () => {} }).map((r) => r.id).sort(), ['w1', 'w2']);
  assert.deepEqual(readRunFamilyReports(join(fx.base, '.', 'sd-1')).map((r) => r.id).sort(), ['w1', 'w2']);
  assert.deepEqual(readRunFamilyReports(join(fx.base, 'sd-1-b', 'gone')), [], 'a dir that is no run dir reads as no reports');
});

test('readRunFamilyReports: a dir spelled with a trailing slash, or through a symlink, is read once', () => {
  const fx = scopedEngineFixture({ 'sd-1': {}, 'sd-1-b': {} });
  put(fx.dirs['sd-1'], 'w1', { startedAt: STARTED, issues: [] });
  put(fx.dirs['sd-1-b'], 'w2', { startedAt: STARTED, issues: [] });
  const link = join(fx.base, 'link');
  symlinkSync(fx.dirs['sd-1'], link);
  for (const spelling of [`${fx.dirs['sd-1']}/`, link]) {
    // The listing's own path for sd-1 is a different string from the spelling, and names the same dir.
    assert.deepEqual(readRunFamilyReports(spelling, { warn: () => {}, runId: 'sd-1' }).map((r) => r.id).sort(), ['w1', 'w2'], spelling);
  }
});

test('readRunFamilyReports: a runId names the family when the dir\'s own name does not', () => {
  const fx = scopedEngineFixture({ 'sd-1': {}, 'sd-1-retry': {}, 'sd-9': {} });
  for (const [d, id] of [['sd-1', 'w1'], ['sd-1-retry', 'w2'], ['sd-9', 'w3']]) put(fx.dirs[d], id, { startedAt: STARTED, issues: [] });
  assert.deepEqual(readRunFamilyReports(fx.dirs['sd-1-retry'], { warn: () => {} }).map((r) => r.id), ['w2']);
  assert.deepEqual(readRunFamilyReports(fx.dirs['sd-1-retry'], { warn: () => {}, runId: 'sd-1' }).map((r) => r.id).sort(), ['w1', 'w2']);
});

test('readRunFamilyReports: a parent that cannot be listed is warned about and leaves the dir alone', { skip: process.getuid?.() === 0 }, () => {
  const fx = scopedEngineFixture({ 'sd-1': {}, 'sd-1-b': {} });
  put(fx.dirs['sd-1'], 'w1', { startedAt: STARTED, issues: [] });
  put(fx.dirs['sd-1-b'], 'w2', { startedAt: STARTED, issues: [] });
  chmodSync(fx.base, 0o311);
  const warnings = [];
  try {
    assert.deepEqual(readRunFamilyReports(fx.dirs['sd-1'], { warn: (m) => warnings.push(m) }).map((r) => r.id), ['w1']);
  } finally { chmodSync(fx.base, 0o755); }
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes(fx.base) && /cannot list/.test(warnings[0]), warnings[0]);
});

test('reportOwnership: the reports each read lists are built once, whatever the number of calls', () => {
  const all = reads(['w1', D1, [row({ ran: true })]], ['w2', D2, [row({ ran: true })]]);
  const own = reportOwnership(all);
  assert.deepEqual([...own.listing.keys()].sort(), ['w1', 'w2']);
  assert.equal(own.listing, own.listing);
  assert.deepEqual([...own.listing.get('w1')], [REF]);
});

test('reportOwnership: rowOf is the row a read has for a ref, counted or not, or null', () => {
  const all = reads(['w1', D1, [row({ prNumber: 5 })]], ['w2', D2, [row({ ref: 'o/r#2' })], { startedAt: undefined }]);
  const own = reportOwnership(all);
  assert.equal(own.rowOf('w1', REF).prNumber, 5);
  assert.equal(own.rowOf('w2', 'o/r#2').ref, 'o/r#2', 'a read with no startedAt still has rows');
  assert.equal(own.rowOf('w2', REF), null);
  assert.equal(own.rowOf('no-such-report', REF), null);
});
