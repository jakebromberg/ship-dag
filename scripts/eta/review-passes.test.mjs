// Tests for when each ticket's PR last passed review, read from a run family's review rounds through the shared
// round matcher and the review gate. Fixtures are real dirs under a temp state base, with pinned mtimes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewPasses, main } from './review-passes.mjs';
import { artifactStem } from '../lib/failure.mjs';

const RUN = 'sd-20261017-080000';
const at = (h) => new Date(Date.UTC(2026, 9, 17, h));
const bases = [];
test.after(() => bases.forEach((b) => rmSync(b, { recursive: true, force: true })));

const CLEAN = { issue: 1, findings: [] };
const NIT = { issue: 1, findings: [{ category: 'simplification', verdict: 'PLAUSIBLE', summary: 'nit' }] };
const BLOCKING = { issue: 1, findings: [{ category: 'correctness', verdict: 'CONFIRMED', summary: 'bug' }] };
const CONVENTION = { issue: 1, findings: [{ category: 'convention', verdict: 'CONFIRMED', summary: 'unbraced if' }] };

/** A state base whose run dir holds `rounds`: `[ref, tag, review, hour, {raw?}]`, and a sidecar naming `blockOn`. */
function fixture(rounds, { blockOn } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'eta-reviews-'));
  bases.push(base);
  const dir = join(base, RUN, 'reviews');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(base, `${RUN}-w1b`));
  if (blockOn) {
    writeFileSync(join(base, RUN, 'ship-dag-wave.jsonl'), `${JSON.stringify({ runId: RUN, wave: 1, blockOn, issues: [] })}\n`);
  }
  for (const [ref, tag, review, hour, { raw } = {}] of rounds) {
    const path = join(dir, `${artifactStem(ref)}${tag}.json`);
    writeFileSync(path, JSON.stringify(review));
    if (raw) {
      writeFileSync(`${path}.raw`, 'lost findings');
    }
    utimesSync(path, at(hour), at(hour));
  }
  return base;
}

for (const [name, rounds, want] of [
  ['the round that passed after a blocking one', [['o/r#1', '', BLOCKING, 10], ['o/r#1', '.r2', CLEAN, 12]], { 'o/r#1': at(12) }],
  ['the latest passing round, though a later round blocked', [['o/r#1', '', NIT, 10], ['o/r#1', '.r2', BLOCKING, 12]], { 'o/r#1': at(10) }],
  ['nothing for a ticket whose every round blocked', [['o/r#1', '', BLOCKING, 10]], {}],
  ['nothing for an empty review beside its .raw (findings that never reached the file)', [['o/r#1', '', CLEAN, 10, { raw: true }]], {}],
  ['nothing for a ticket with no rounds', [], {}],
  ['each ref apart, #1 never matching #12', [['o/r#1', '', CLEAN, 9], ['o/r#12', '', CLEAN, 11]], { 'o/r#1': at(9), 'o/r#12': at(11) }],
]) {
  test(`reviewPasses: ${name}`, () => {
    const base = fixture(rounds);
    const got = reviewPasses({ runDir: join(base, RUN), refs: ['o/r#1', 'o/r#12'] });
    assert.deepEqual(Object.fromEntries(got), Object.fromEntries(Object.entries(want).map(([k, v]) => [k, v.getTime()])));
  });
}

for (const [blockOn, want] of [[undefined, {}], [['correctness', 'security'], { 'o/r#1': at(10).getTime() }]]) {
  test(`reviewPasses gates by the run's own blockOn (${blockOn ? blockOn.join(',') : 'the default'})`, () => {
    const base = fixture([['o/r#1', '', CONVENTION, 10]], { blockOn });
    assert.deepEqual(Object.fromEntries(reviewPasses({ runDir: join(base, RUN), refs: ['o/r#1'] })), want);
  });
}

test('reviewPasses takes the blockOn of the newest sidecar entry by emittedAt, not by dir name (-w10 sorts before -w2)', () => {
  const base = fixture([['o/r#1', '', CONVENTION, 10]]);
  const sidecar = (name, blockOn, emittedAt) => {
    mkdirSync(join(base, name), { recursive: true });
    writeFileSync(join(base, name, 'ship-dag-wave.jsonl'), `${JSON.stringify({ runId: RUN, blockOn, emittedAt, issues: [] })}\n`);
  };
  sidecar(`${RUN}-w10`, ['correctness'], at(12).toISOString());
  sidecar(`${RUN}-w2`, ['convention'], at(9).toISOString());
  assert.deepEqual(Object.fromEntries(reviewPasses({ runDir: join(base, RUN), refs: ['o/r#1'] })), { 'o/r#1': at(10).getTime() });
});

test('reviewPasses gates each ref by its own wave\'s blockOn, not by a later wave\'s', () => {
  const base = fixture([['o/r#1', '', CONVENTION, 10]]);
  const entry = (blockOn, emittedAt, refs) => JSON.stringify({ runId: RUN, blockOn, emittedAt, issues: refs.map((ref) => ({ ref })) });
  mkdirSync(join(base, `${RUN}-w2`));
  writeFileSync(join(base, RUN, 'ship-dag-wave.jsonl'), `${entry(['correctness'], at(8).toISOString(), ['o/r#1'])}\n`);
  writeFileSync(join(base, `${RUN}-w2`, 'ship-dag-wave.jsonl'), `${entry(['convention'], at(11).toISOString(), ['o/r#2'])}\n`);
  assert.deepEqual(Object.fromEntries(reviewPasses({ runDir: join(base, RUN), refs: ['o/r#1'] })), { 'o/r#1': at(10).getTime() });
});

test('the CLI exits 1, with no JSON, when the run\'s state cannot be read', () => {
  const base = fixture([['o/r#1', '', CLEAN, 10]]);
  mkdirSync(join(base, RUN, 'ship-dag-wave.jsonl'));
  const out = [];
  const err = [];
  assert.equal(main(['--state-base', base, '--run', RUN, '--refs', 'o/r#1'], { stdout: (s) => out.push(s), stderr: (s) => err.push(s) }), 1);
  assert.deepEqual(out, []);
  assert.match(err.join(''), /cannot read .*review rounds/);
});

test('the CLI prints each ref\'s pass time as JSON, for a host that runs it through node', () => {
  const base = fixture([['o/r#1', '', CLEAN, 10]]);
  const out = [];
  const code = main(['--state-base', base, '--run', RUN, '--refs', 'o/r#1,o/r#2'], { stdout: (s) => out.push(s), stderr: () => {} });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out.join('')), { 'o/r#1': at(10).getTime() });
});

test('the CLI exits 64 without --run', () => {
  const err = [];
  assert.equal(main(['--refs', 'o/r#1'], { stdout: () => {}, stderr: (s) => err.push(s) }), 64);
  assert.match(err.join(''), /usage/);
});
