// is-main.test.mjs — the entry-point guard must survive symlinked invocation.
//
// Regression context: the skill is installed as a symlink
// (`ln -s ~/Developer/ship-dag ~/.claude/skills/ship-dag`) and SKILL.md invokes
// every CLI through it (`node "$SD/scripts/plan-waves.mjs" ...`). Node realpaths
// `import.meta.url` but leaves `process.argv[1]` as the symlink path, so the old
// `import.meta.url === \`file://${process.argv[1]}\`` guard is false and main()
// silently never runs — a dead wave loop / empty telemetry report.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain } from './is-main.mjs';

// Some hosts (Windows without Developer Mode, hardened sandboxes) can't create
// symlinks. Probe once so the symlink case skips cleanly there instead of
// failing the whole file — the non-symlink cases don't need the capability.
const CAN_SYMLINK = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'ismain-probe-'));
  try { symlinkSync(join(probe, 't'), join(probe, 'l')); return true; }
  catch { return false; }
  finally { rmSync(probe, { recursive: true, force: true }); }
})();

/** Materialize a real module file and a symlink pointing at it. */
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ismain-')));
  const real = join(dir, 'cli.mjs');
  const link = join(dir, 'link.mjs');
  const other = join(dir, 'other.mjs');
  writeFileSync(real, 'export const x = 1;\n');
  writeFileSync(other, 'export const y = 2;\n');
  if (CAN_SYMLINK) symlinkSync(real, link);
  // `import.meta.url` as Node reports it for the entry module: the realpath.
  const selfUrl = pathToFileURL(realpathSync(real)).href;
  return { dir, real, link, other, selfUrl, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('isMain: true when invoked directly (argv[1] is the module itself)', () => {
  const f = fixture();
  try {
    assert.equal(isMain(f.selfUrl, f.real), true);
  } finally { f.cleanup(); }
});

test('isMain: true when invoked THROUGH a symlink (the documented skill install)', { skip: CAN_SYMLINK ? false : 'host cannot create symlinks' }, () => {
  const f = fixture();
  try {
    // This is the case the old guard got wrong.
    assert.equal(isMain(f.selfUrl, f.link), true);
    // Prove the old naive guard would indeed have failed here:
    assert.notEqual(f.selfUrl, `file://${f.link}`);
  } finally { f.cleanup(); }
});

test('isMain: false when the module is imported, not the entry point', () => {
  const f = fixture();
  try {
    // argv[1] is a *different* script that imported this module.
    assert.equal(isMain(f.selfUrl, f.other), false);
  } finally { f.cleanup(); }
});

test('isMain: false (never throws) when argv[1] is missing or nonexistent', () => {
  const f = fixture();
  try {
    assert.equal(isMain(f.selfUrl, undefined), false);
    assert.equal(isMain(f.selfUrl, join(f.dir, 'gone.mjs')), false);
  } finally { f.cleanup(); }
});
