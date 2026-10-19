// Parity: the ETA plugin cannot import scripts/lib (an installed plugin reaches nothing outside its folder), so it
// carries copies of the engine helpers. This holds each copy equal to its original over a table of inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRunId, runFamily } from '../lib/run-id.mjs';
import { parseRef } from '../lib/ref.mjs';
import { artifactStem } from '../lib/failure.mjs';
import * as copy from '../../plugins/ship-dag-eta/lib/run-id.mjs';
import { parseRef as copyParseRef, stem } from '../../plugins/ship-dag-eta/lib/state.mjs';

const RUN = 'sd-20261017-080000';
const IDS = [RUN, `${RUN}-w1`, `${RUN}-w1b`, `${RUN}-w37aa`, `${RUN}-b`, `${RUN}-b-c`, `${RUN}-r2`, `${RUN}-resume`, `${RUN}-wave3`,
  `ship-dag-${RUN}`, `ship-dag-${RUN}-w2`, `SD-20261017-080000-W2`, `${RUN.toUpperCase()}-B`, `${RUN}-label`, `${RUN}x`, 'sd-20261017-0800001', '', '  ', null, undefined, 7];
const REFS = ['o/r#1', 'o/r#12', 'O/R#3', 'o/r', 'o/r#', 'o/r#1x', 'o/r/s#1', ' o/r#1', 'o r#1', '#1', 'a%b/c#2', null, undefined, 7, ['o/r#1']];

test('canonicalRunId and runFamily copies agree with the originals', () => {
  for (const id of IDS) {
    assert.equal(copy.canonicalRunId(id), canonicalRunId(id), `canonicalRunId(${JSON.stringify(id)})`);
    assert.equal(copy.runFamily(id), runFamily(id), `runFamily(${JSON.stringify(id)})`);
  }
});

test('parseRef and stem copies agree with the originals', () => {
  for (const ref of REFS) {
    assert.deepEqual(copyParseRef(ref), parseRef(ref), `parseRef(${JSON.stringify(ref)})`);
    assert.equal(stem(ref), artifactStem(ref), `stem(${JSON.stringify(ref)})`);
  }
});
