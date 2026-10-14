// Tests for the status board's static assets: the stylesheet's tokens are
// complete in both themes, and the browser script at least parses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_CSS, ROAD_JS } from './assets.mjs';

const declared = (css) => new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const lightBlock = PAGE_CSS.match(/^:root\{([^}]*)\}/m)[1];
const darkBlock = PAGE_CSS.match(/:root:not\(\[data-theme="light"\]\)\{([^}]*)\}/)?.[1];

test('the dark tokens sit under prefers-color-scheme, guarded so an explicit light theme wins', () => {
  assert.match(PAGE_CSS, /@media \(prefers-color-scheme: dark\)\{:root:not\(\[data-theme="light"\]\)\{/);
  assert.ok(darkBlock, 'dark block found');
});

test('every token the light theme defines, the dark theme redefines', () => {
  assert.deepEqual([...declared(darkBlock)].sort(), [...declared(lightBlock)].sort());
});

test('every var() the page uses is defined', () => {
  const defined = declared(lightBlock);
  const used = new Set([...(PAGE_CSS + ROAD_JS).matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]));
  // The page's HTML also references tokens (bar segments, legend swatches); render.mjs's
  // own tests cover those. Here: the stylesheet and script are self-consistent.
  assert.deepEqual([...used].filter((v) => !defined.has(v)), []);
});

test('the road-ahead script parses', () => {
  assert.doesNotThrow(() => new Function(ROAD_JS)); // compiles only; it touches the DOM when run
});

// A chip shows a status in the colours its legend swatch and node border use:
// waiting on other tickets is grey, waiting on you is red.
for (const [status, token] of [
  ['shipped', 'ship'], ['flight', 'flight'], ['ready', 'ready'], ['you', 'block'], ['blocked', 'queued'], ['dropped', 'queued'],
]) {
  test(`.c-${status} is coloured --${token}`, () => {
    const rule = [...PAGE_CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .find(([, sel]) => sel.split(',').some((s) => s.trim() === `.c-${status}`));
    assert.ok(rule, `.c-${status} has a rule`);
    assert.equal(rule[2], `color:var(--${token});background:var(--${token}-bg)`);
  });
}

// The script's view of the page: just what draw() reads and writes.
function fakePage({ clientWidth, clientHeight, scrollWidth, scrollHeight }) {
  const attrs = {};
  const svg = { setAttribute: (k, v) => { attrs[k] = String(v); }, set innerHTML(_) {} };
  const dag = {
    dataset: { edges: '[]' }, clientWidth, clientHeight, scrollWidth, scrollHeight,
    querySelector: () => svg, querySelectorAll: () => [], getBoundingClientRect: () => ({ left: 0, top: 0 }),
    classList: { add() {}, remove() {} },
  };
  const document = { getElementById: () => dag };
  return { attrs, run: () => new Function('document', 'window', 'addEventListener', ROAD_JS)(document, {}, () => {}) };
}

test('the edge layer takes the dag\'s own size, so it can shrink after a resize', () => {
  // The SVG from the last, wider draw still overflows: scroll size is stale, client size is not.
  const page = fakePage({ clientWidth: 600, clientHeight: 400, scrollWidth: 1200, scrollHeight: 900 });
  page.run();
  assert.deepEqual(page.attrs, { width: '600', height: '400' });
});
