// Tests for the engine's post-run failure digest. The line-level parsing and
// the diagnosis shape are covered in ../lib/failure.test.mjs — this file covers
// the streaming reader and the per-row write pass.
// Run: node --test "skills/ship-dag/scripts/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanTranscript, readExitCode, writeFailureDigests } from './failure-digest.mjs';

const line = (obj) => `${JSON.stringify(obj)}\n`;
const REF = 'daisysguide/backend#620';
const STEM = 'daisysguide%2Fbackend%23620';

const result = (over = {}) => line({ type: 'result', subtype: 'success', is_error: true, num_turns: 67, result: 'died', ...over });
const quotaTurn = () => line({ type: 'assistant', message: { role: 'assistant' }, error: 'rate_limit', is_api_error_message: true });

function configDir({ log, meta } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ship-dag-digest-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  mkdirSync(join(dir, 'metadata'), { recursive: true });
  if (log !== undefined) writeFileSync(join(dir, 'logs', `issue-${STEM}.log`), log);
  if (meta !== undefined) writeFileSync(join(dir, 'metadata', `issue-${STEM}.json`), meta);
  return dir;
}

test('scanTranscript: a missing file yields nothing found, not a throw', async () => {
  assert.deepEqual(await scanTranscript('/nope/nothing.log'), { terminal: null, rateLimited: false });
});

test('scanTranscript: collects the last terminal event and the rate-limit signature in one pass', async () => {
  const dir = configDir({ log: result({ result: 'first', is_error: false }) + quotaTurn() + result({ result: 'last' }) });
  const { terminal, rateLimited } = await scanTranscript(join(dir, 'logs', `issue-${STEM}.log`));
  assert.equal(terminal.reason, 'last');
  assert.equal(rateLimited, true);
});

test('scanTranscript: ignores hook-tagged result events', async () => {
  const dir = configDir({ log: result({ result: 'real' }) + line({ type: 'result', subtype: 'success', hook_event_name: 'Stop', result: 'hook' }) });
  assert.equal((await scanTranscript(join(dir, 'logs', `issue-${STEM}.log`))).terminal.reason, 'real');
});

test('scanTranscript: a torn trailing line does not lose what came before it', async () => {
  const dir = configDir({ log: `${result({ result: 'real' })}{"type":"resu` });
  assert.equal((await scanTranscript(join(dir, 'logs', `issue-${STEM}.log`))).terminal.reason, 'real');
});

test('readExitCode: reads a numeric exitCode, else null', () => {
  const dir = configDir({ meta: JSON.stringify({ exitCode: 143 }) });
  assert.equal(readExitCode(join(dir, 'metadata', `issue-${STEM}.json`)), 143);
  assert.equal(readExitCode(join(dir, 'metadata', 'absent.json')), null);
  const bad = configDir({ meta: 'not json' });
  assert.equal(readExitCode(join(bad, 'metadata', `issue-${STEM}.json`)), null);
});

test('writeFailureDigests: one file per non-succeeded row, succeeded rows skipped', async () => {
  const dir = configDir({ log: result(), meta: JSON.stringify({ exitCode: 1 }) });
  const written = await writeFailureDigests({
    configDir: dir,
    report: { issues: [{ ref: REF, status: 'failed', prNumber: 625 }, { ref: 'o/r#1', status: 'succeeded', prNumber: 5 }] },
  });
  assert.equal(written.length, 1);
  assert.match(written[0], new RegExp(`issue-${STEM.replace(/%/g, '%')}\\.json$`));
  assert.equal(existsSync(join(dir, 'failure-digest', 'issue-o%2Fr%231.json')), false);
});

test('writeFailureDigests: the digest carries the report id it was given, and none when not given', async () => {
  const dir = configDir({ log: result() });
  const rows = [{ ref: REF, status: 'failed' }];
  const [stamped] = await writeFailureDigests({ configDir: dir, report: { issues: rows }, reportId: 'w1' });
  assert.equal(JSON.parse(readFileSync(stamped, 'utf-8')).reportId, 'w1');
  const [bare] = await writeFailureDigests({ configDir: dir, report: { issues: rows } });
  assert.equal('reportId' in JSON.parse(readFileSync(bare, 'utf-8')), false);
});

test('writeFailureDigests: the digest carries the route, not just the reason', async () => {
  // The whole point. A failed row with a PR belongs at the review gate; an exit
  // code and a terminal reason do not say that on their own, and the run this
  // was written for was retried-by-recommendation instead.
  const dir = configDir({ log: quotaTurn() + result(), meta: JSON.stringify({ exitCode: 1 }) });
  const [p] = await writeFailureDigests({ configDir: dir, report: { issues: [{ ref: REF, status: 'failed', prNumber: 625 }] } });
  const d = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(d.route, 'review-gate');
  assert.equal(d.failureReason, 'rate-limited');
  assert.equal(d.exitCode, 1);
  assert.equal(d.terminal.isError, true);
});

test('writeFailureDigests: a PR-less quota death routes to point E, an ordinary one to point B', async () => {
  const quota = configDir({ log: quotaTurn() + result() });
  const [pe] = await writeFailureDigests({ configDir: quota, report: { issues: [{ ref: REF, status: 'failed' }] } });
  assert.equal(JSON.parse(readFileSync(pe, 'utf8')).route, 'point-E');

  const plain = configDir({ log: result({ subtype: 'error_during_execution', result: 'tests failed' }) });
  const [pb] = await writeFailureDigests({ configDir: plain, report: { issues: [{ ref: REF, status: 'failed' }] } });
  assert.equal(JSON.parse(readFileSync(pb, 'utf8')).route, 'point-B');
});

test('writeFailureDigests: a row with no transcript or metadata still gets a routed digest', async () => {
  const dir = configDir();
  const [p] = await writeFailureDigests({ configDir: dir, report: { issues: [{ ref: REF, status: 'blocked' }] } });
  const d = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(d.terminal, null);
  assert.equal(d.exitCode, null);
  assert.equal(d.route, 'point-B');
});

test('writeFailureDigests: no non-succeeded rows writes nothing and creates no dir', async () => {
  const dir = configDir();
  assert.deepEqual(await writeFailureDigests({ configDir: dir, report: { issues: [{ ref: REF, status: 'succeeded' }] } }), []);
  assert.equal(existsSync(join(dir, 'failure-digest')), false);
  assert.deepEqual(await writeFailureDigests({ configDir: dir, report: {} }), []);
});
