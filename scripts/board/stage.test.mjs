// Tests for deriving a ticket's stage from the files the engine and the review
// gate already write. Each case builds a throwaway run dir with just the files
// that case needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveStage } from './stage.mjs';
import { artifactStem } from '../lib/failure.mjs';
import { DEFAULT_BLOCK_ON } from '../review-gate.mjs';

const REF = 'o/r#12';
const WAVE_TS = Date.parse('2026-10-08T17:00:00Z');
const finding = (category, extra = {}) => ({ category, verdict: 'CONFIRMED', blocking: true, file: 'a.ts', line: 1, summary: 's', failure_scenario: 'f', ...extra });

/**
 * A run dir holding only what the case declares. `reviews` maps a file name
 * (relative to reviews/) to its JSON value, or to a string for raw bytes, and
 * an optional `ageSec` per name sets its mtime that far in the past.
 */
function runDir({ status, metadata, runs = [], reviews = {}, ages = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stage-'));
  const stem = artifactStem(REF);
  for (const sub of ['state/status', 'state/metadata', 'state/runs', 'reviews/passes']) mkdirSync(join(dir, sub), { recursive: true });
  if (status) writeFileSync(join(dir, 'state/status', `issue-${stem}.status`), status);
  if (metadata) writeFileSync(join(dir, 'state/metadata', `issue-${stem}.json`), JSON.stringify(metadata));
  runs.forEach((r, i) => writeFileSync(join(dir, 'state/runs', `run-${i}.json`), JSON.stringify(r)));
  for (const [name, body] of Object.entries(reviews)) {
    const path = join(dir, 'reviews', name.replaceAll('STEM', stem));
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
    const age = ages[name] ?? 0;
    const t = new Date(Date.now() - age * 1000);
    utimesSync(path, t, t);
  }
  return dir;
}

const derive = (dir, over = {}) => deriveStage({
  dir, ref: REF, waveTs: WAVE_TS, reviewDirs: [join(dir, 'reviews')], blockOn: DEFAULT_BLOCK_ON, prOpen: true, ...over,
});

const laterRun = { startedAt: '2026-10-08T18:00:00Z', statuses: { [REF]: 'failed' } };
const earlierRun = { startedAt: '2026-10-08T16:00:00Z', statuses: { [REF]: 'succeeded' } };
const PR = { prNumber: 99 };

for (const [name, files, over, want] of [
  ['running with no later run record is Building', { status: 'running' }, {}, 'Building'],
  ['running listed by a run that started after the wave is a dead session: Stalled', { status: 'running', runs: [laterRun] }, {}, 'Stalled'],
  ['running listed only by an earlier run is still Building', { status: 'running', runs: [earlierRun] }, {}, 'Building'],
  ['failed with no PR is Stalled', { status: 'failed', metadata: {} }, { prOpen: false }, 'Stalled'],
  ['interrupted with no PR is Stalled', { status: 'interrupted' }, { prOpen: false }, 'Stalled'],
  ['failed with a PR is review work, not a stall: In review', { status: 'failed', metadata: PR }, {}, 'In review'],
  ['an open PR with no review file is In review', { status: 'succeeded', metadata: PR }, {}, 'In review'],
  ['a blocking review is Fixing', { status: 'succeeded', metadata: PR, reviews: { 'STEM.json': { findings: [finding('correctness')] } } }, {}, 'Fixing'],
  ['a review with only nits is Reviewed, never "ready to merge"',
    { status: 'succeeded', metadata: PR, reviews: { 'STEM.json': { findings: [finding('simplification', { blocking: false })] } } }, {}, 'Reviewed'],
  ['an empty review beside a .raw sibling is the #2587 signature: Review unreadable',
    { status: 'succeeded', metadata: PR, reviews: { 'STEM.json': { findings: [] }, 'STEM.json.raw': 'four findings' } }, {}, 'Review unreadable'],
  ['an unparseable review is Review unreadable', { status: 'succeeded', metadata: PR, reviews: { 'STEM.json': '{"findings": [' } }, {}, 'Review unreadable'],
  ['a review with no findings array is Review unreadable', { status: 'succeeded', metadata: PR, reviews: { 'STEM.json': { issue: 12 } } }, {}, 'Review unreadable'],
  ['the newest round wins: an older blocking review, a newer clean .r2',
    { status: 'succeeded', metadata: PR, reviews: { 'STEM.json': { findings: [finding('correctness')] }, 'STEM.r2.json': { findings: [] } }, ages: { 'STEM.json': 60 } }, {}, 'Reviewed'],
  ['a legacy -rN round file counts as a round',
    { status: 'succeeded', metadata: PR, reviews: { 'STEM.json': { findings: [] }, 'STEM-r2.json': { findings: [finding('correctness')] } }, ages: { 'STEM.json': 60 } }, {}, 'Fixing'],
  ["#123's review is never read as #12's",
    { status: 'succeeded', metadata: PR, reviews: { 'o%2Fr%23123.json': { findings: [finding('correctness')] } } }, {}, 'In review'],
  ['a per-pass file under reviews/passes/ is never scored',
    { status: 'succeeded', metadata: PR, reviews: { 'passes/STEM.1.verify.json': { findings: [finding('correctness')] } } }, {}, 'In review'],
  ['the run\'s --block-on decides: contract does not block when only correctness does',
    { status: 'succeeded', metadata: PR, reviews: { 'STEM.json': { findings: [finding('contract')] } } }, { blockOn: ['correctness'] }, 'Reviewed'],
  ['no engine state and no open PR derives nothing', {}, { prOpen: false }, null],
]) {
  test(`deriveStage: ${name}`, () => {
    assert.equal(derive(runDir(files), over), want);
  });
}

test('deriveStage reads the newest review across every family dir it is given', () => {
  const base = runDir({ status: 'succeeded', metadata: PR, reviews: { 'STEM.json': { findings: [finding('correctness')] } }, ages: { 'STEM.json': 60 } });
  const sibling = runDir({ reviews: { 'STEM.json': { findings: [] } } });
  assert.equal(derive(base, { reviewDirs: [join(base, 'reviews'), join(sibling, 'reviews')] }), 'Reviewed');
});
