// Tests for the status board's static assets: the stylesheet's tokens are
// complete in both themes, and the browser script at least parses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const CHIP_TOKENS = [
  ['shipped', 'ship'], ['flight', 'flight'], ['ready', 'ready'], ['you', 'block'], ['blocked', 'queued'], ['dropped', 'queued'],
];
const RULES = [...PAGE_CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, sel, body]) => ({ sels: sel.split(',').map((s) => s.trim()), body }));
for (const [status, token] of CHIP_TOKENS) {
  test(`.c-${status} is coloured --${token}`, () => {
    // Every rule naming the class, not just the first: a later one would win in the browser.
    const colouring = RULES.filter((r) => r.sels.includes(`.c-${status}`) && /(^|;)\s*(color|background)\s*:/.test(r.body));
    assert.equal(colouring.length, 1, `exactly one rule colours .c-${status}`);
    assert.equal(colouring[0].body, `color:var(--${token});background:var(--${token}-bg)`);
  });
}

test('every chip class the stylesheet styles is a status', () => {
  const chips = new Set(RULES.flatMap((r) => r.sels).filter((s) => /^\.c-[\w-]+$/.test(s)));
  assert.deepEqual([...chips].sort(), CHIP_TOKENS.map(([status]) => `.c-${status}`).sort());
});

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

// A fuller fake: nodes that count measurements and carry classes, paths parsed out of the
// svg markup the script writes, and an observer-less or observer-ful window.
function fakeDag({ ro = true, edges = [['a', 'b', 0], ['b', 'c', 1]] } = {}) {
  const classes = () => { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), has: (c) => s.has(c), contains: (c) => s.has(c), toggle: (c, on) => (on ? s.add(c) : s.delete(c)), s }; };
  const handlers = {};
  const nodes = {};
  for (const [ref, anc, desc] of [['a', '', 'b c'], ['b', 'a', 'c'], ['c', 'a b', ''], ['d', '', '']]) {
    const n = { dataset: { ref, anc, desc }, classList: classes(), measured: 0, h: {} };
    n.getBoundingClientRect = () => { n.measured++; return { left: 0, top: 0, width: 10, bottom: 10 }; };
    n.addEventListener = (ev, fn) => { n.h[ev] = fn; };
    nodes[ref] = n;
  }
  let paths = [];
  const svg = {
    setAttribute() {},
    set innerHTML(html) {
      paths = [...html.matchAll(/<path data-a="(\w+)" data-b="(\w+)" class="(\w*)" marker-end="([^"]*)"/g)].map(([, a, b, cls, m]) => {
        const p = { dataset: { a, b }, classList: classes(), attrs: { 'marker-end': m } };
        if (cls) p.classList.add(cls);
        p.setAttribute = (k, v) => { p.attrs[k] = v; };
        return p;
      });
    },
    querySelectorAll: () => paths,
  };
  const dag = {
    dataset: { edges: JSON.stringify(edges) }, clientWidth: 1, clientHeight: 1, querySelector: () => svg,
    querySelectorAll: () => Object.values(nodes), getBoundingClientRect: () => ({ left: 0, top: 0 }), classList: classes(),
  };
  const doc = { getElementById: () => dag, activeElement: null };
  const calls = { observed: 0, resize: 0, observerDraws: null };
  const win = {};
  if (ro) win.ResizeObserver = function (fn) { calls.observerDraws = fn; this.observe = () => { calls.observed++; }; };
  const run = () => new Function('document', 'window', 'addEventListener', 'ResizeObserver', ROAD_JS)(
    doc, win, (ev) => { if (ev === 'resize') calls.resize++; }, win.ResizeObserver);
  return { nodes, dag, doc, calls, run, paths: () => paths };
}

test('each node is measured once per draw, however many edges touch it', () => {
  const page = fakeDag();
  page.run();
  assert.deepEqual(Object.values(page.nodes).map((n) => n.measured), [1, 1, 1, 1]);
});

test('the window resize listener is only added without ResizeObserver', () => {
  const withRo = fakeDag({ ro: true });
  withRo.run();
  assert.equal(withRo.calls.resize, 0);
  assert.equal(withRo.calls.observed, 1);
  const without = fakeDag({ ro: false });
  without.run();
  assert.equal(without.calls.resize, 1);
});

test('a lit edge uses the accent arrowhead, and clearing restores each edge\'s own', () => {
  const page = fakeDag();
  page.run();
  page.nodes.a.h.mouseenter();
  assert.deepEqual(page.paths().map((p) => p.attrs['marker-end']), ['url(#ahc)', 'url(#ahc)']);
  page.nodes.d.h.mouseenter();
  assert.deepEqual(page.paths().map((p) => p.attrs['marker-end']), ['url(#ah)', 'url(#ahc)']);
  page.nodes.d.h.mouseleave();
  assert.deepEqual(page.paths().map((p) => p.attrs['marker-end']), ['url(#ah)', 'url(#ahc)']);
});

test('focus survives a redraw', () => {
  const page = fakeDag();
  page.run();
  page.nodes.b.h.mouseenter();
  page.calls.observerDraws();
  assert.ok(page.dag.classList.has('focusing'));
  assert.deepEqual(page.paths().map((p) => p.classList.has('lit')), [true, true]);
  assert.ok(page.nodes.d.classList.has('dim'));
});

test('keyboard focus survives a hover elsewhere', () => {
  const page = fakeDag();
  page.run();
  page.doc.activeElement = page.nodes.c;
  page.nodes.c.h.focus();
  page.nodes.d.h.mouseenter();
  page.nodes.d.h.mouseleave();
  assert.ok(page.dag.classList.has('focusing'));
  assert.ok(!page.nodes.c.classList.has('dim'));
  assert.ok(page.nodes.d.classList.has('dim'));
  page.doc.activeElement = null;
  page.nodes.c.h.blur();
  assert.ok(!page.dag.classList.has('focusing'));
});

test('edges dim with path opacity, which reaches the arrowhead', () => {
  assert.match(PAGE_CSS, /\.dag\.focusing path\[data-a\]\{opacity:/);
  assert.doesNotMatch(PAGE_CSS, /stroke-opacity:\.08/);
});

test('dead wave rules are gone and the card surface is declared once', () => {
  assert.doesNotMatch(PAGE_CSS, /\.waves?\b/);
  assert.equal(PAGE_CSS.match(/background:var\(--card\);border:1px solid var\(--line\)/g).length, 1);
});

test('the render module carries no inline layout styles, only data-driven ones', () => {
  const src = readFileSync(new URL('./render.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /style="margin/);
  for (const cls of ['gap', 'tight']) assert.match(PAGE_CSS, new RegExp(`\\.meta\\.${cls}\\{margin`));
});
