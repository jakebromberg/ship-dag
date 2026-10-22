// write-atomic.mjs — write a file through a temp file beside it, so a reader never sees it half written.
import { renameSync, rmSync, writeFileSync } from 'node:fs';

/** Write `text` to `path` through a temp file beside it, so a failure leaves the old file byte-identical. */
export function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
