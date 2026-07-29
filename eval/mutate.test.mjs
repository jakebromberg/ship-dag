// Tests for mutate.mjs. Run: node --test "skills/ship-dag/eval/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMutants, applyMutant } from './mutate.mjs';

function only(kind, source) {
  return generateMutants(source, { kinds: [kind] }).mutants;
}

test('relational: flips a space-flanked comparison and applyMutant rewrites it', () => {
  const src = 'if (a < b) return;';
  const [m] = only('relational', src);
  assert.equal(m.before, '<');
  assert.equal(m.after, '<=');
  assert.equal(applyMutant(src, m), 'if (a <= b) return;');
});

test('relational: does NOT mutate arrows (=>) or generics (Array<T>)', () => {
  assert.equal(only('relational', 'const f = (x) => x;').length, 0);
  assert.equal(only('relational', 'let v: Array<Item> = [];').length, 0);
  // but a real spaced comparison beside an arrow is still caught (just the `>`)
  const ms = only('relational', 'xs.map((x) => x > 0)');
  assert.equal(ms.length, 1);
  assert.equal(ms[0].before, '>');
});

test('equality: flips == to != (and leaves => untouched)', () => {
  const src = 'return x == y;';
  const [m] = only('equality', src);
  assert.equal(applyMutant(src, m), 'return x != y;');
  assert.equal(only('equality', 'arr.filter((x) => x)').length, 0);
});

test('boolean: flips JS and Python literals', () => {
  assert.equal(applyMutant('return true;', only('boolean', 'return true;')[0]), 'return false;');
  assert.equal(applyMutant('ok = False', only('boolean', 'ok = False')[0]), 'ok = True');
});

test('await: dropping the keyword yields an unawaited call', () => {
  const src = 'const r = await fetchThing();';
  const [m] = only('await', src);
  assert.equal(applyMutant(src, m), 'const r = fetchThing();');
});

test('off-by-one: bumps a lone 1 operand but not multi-digit numbers', () => {
  assert.equal(applyMutant('n + 1', only('off-by-one', 'n + 1')[0]), 'n + 2');
  assert.equal(applyMutant('i - 1', only('off-by-one', 'i - 1')[0]), 'i - 2');
  assert.equal(only('off-by-one', 'x + 100').length, 0);
});

test('generateMutants: ordinals count per kind and line numbers are 1-based', () => {
  const src = 'a == b\nc == d\n';
  const ms = only('equality', src);
  assert.deepEqual(ms.map((m) => m.ordinal), [0, 1]);
  assert.deepEqual(ms.map((m) => m.line), [1, 2]);
});

test('generateMutants: limitPerKind caps occurrences and records truncation', () => {
  const src = 'true true true';
  const { mutants, truncated } = generateMutants(src, { kinds: ['boolean'], limitPerKind: 2 });
  assert.equal(mutants.length, 2);
  assert.ok(truncated.includes('boolean'));
});

test('generateMutants: applying one mutant leaves the others intact', () => {
  const src = 'a == b && c == d';
  const ms = only('equality', src);
  assert.equal(applyMutant(src, ms[1]), 'a == b && c != d');
});

test('maskNonCode: operators inside comments, strings, and docstrings are not mutated', () => {
  assert.equal(only('relational', 'x = 1; // a > b').length, 0); // // line comment
  assert.equal(only('relational', 'x = 1  # a > b').length, 0); // #/shell comment
  assert.equal(only('equality', 'msg = "a == b"').length, 0); // string literal
  assert.equal(only('relational', '"""score > 80 here"""').length, 0); // docstring
  assert.equal(only('relational', 'q = 1 -- where a > b').length, 0); // sql comment
});

test('maskNonCode: real code operators next to a comment/string still mutate', () => {
  const src = 'if (a > b) { return "x > y"; } // c < d';
  const ms = only('relational', src);
  assert.equal(ms.length, 1); // only the real `a > b`
  assert.equal(applyMutant(src, ms[0]), 'if (a >= b) { return "x > y"; } // c < d');
});

test('maskNonCode: a whitespace-led # is a comment, but mid-token #field is not', () => {
  assert.equal(only('relational', 'if (this.#n > 0) {}').length, 1); // JS private field, `>` still mutates
});
