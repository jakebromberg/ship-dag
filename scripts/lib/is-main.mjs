// is-main.mjs — symlink-safe "is this module the CLI entry point?" check.
//
// Replaces the fragile `import.meta.url === `file://${process.argv[1]}`` idiom,
// which breaks two ways:
//   1. Symlinked invocation — Node realpaths `import.meta.url` but not
//      `process.argv[1]`, so running `node ~/.claude/skills/ship-dag/scripts/x.mjs`
//      (the documented install symlinks that dir) leaves the two unequal and
//      main() silently never runs.
//   2. Paths with spaces / special characters — raw string concatenation into a
//      `file://` URL is not valid percent-encoding, so the comparison misses.
//
// Both sides are canonicalized through realpath and compared as real paths, so
// the check holds regardless of symlinks on either side or `--preserve-symlinks*`.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} importMetaUrl  the caller's `import.meta.url`
 * @param {string|undefined} [argv1=process.argv[1]]  the invoked script path
 * @returns {boolean} true iff this module is the process entry point
 */
export function isMain(importMetaUrl, argv1 = process.argv[1]) {
  if (!importMetaUrl || !argv1) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argv1);
  } catch {
    // A nonexistent argv[1] (or a non-file import URL) means "not the entry".
    return false;
  }
}
