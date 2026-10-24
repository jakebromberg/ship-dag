// No tracked file names a real user's home directory. ship-dag is public and runs on any machine, so a path under one
// person's home is both a leak and a default that breaks for everyone else: derive it from os.homedir() or $HOME, and
// write examples under a placeholder home. Machine names belong in the host registry outside the repo (hosts.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
/** Homes that examples and fixtures may use; none is a real account. */
export const PLACEHOLDER_HOMES = ['me', 'you'];

/** The `/Users/<name>` and `/home/<name>` paths in `text` whose `<name>` is not a placeholder. */
export function homePaths(text) {
  return [...text.matchAll(/\/(?:Users|home)\/([A-Za-z][\w.-]*)/g)].filter(([, name]) => !PLACEHOLDER_HOMES.includes(name)).map(([path]) => path);
}

// Built from parts, so this file holds no literal home path for the scan below to find.
const [U, H] = ['/Users/', '/home/'];

for (const [name, text, expected] of [
  ['a real home', `cd ${U}alice/Developer && ls ${H}bob`, [`${U}alice`, `${H}bob`]],
  ['a placeholder home', 'ssh mini ls /Users/me/Developer /home/you', []],
  ['a variable home', 'cd "$HOME/Developer" ~/.config ${h.home}/D', []],
]) {
  test(`homePaths finds ${name}`, () => {
    assert.deepEqual(homePaths(text), expected);
  });
}

test('no tracked file names a real home directory', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  const hits = files.flatMap((f) => {
    let text;
    try {
      text = readFileSync(join(ROOT, f), 'utf8');
    } catch {
      return []; // a tracked file deleted in the working tree
    }
    return homePaths(text).map((p) => `${f}: ${p}`);
  });
  assert.deepEqual(hits, [], 'derive the path from os.homedir() or $HOME, or use a placeholder home (PLACEHOLDER_HOMES)');
});
