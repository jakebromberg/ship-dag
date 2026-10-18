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
  for (const ref of ['a', 'b', 'c', 'd']) {
    const n = { dataset: { ref }, classList: classes(), measured: 0, h: {} };
    n.getBoundingClientRect = () => { n.measured++; return { left: 0, top: 0, width: 10, bottom: 10 }; };
    n.addEventListener = (ev, fn) => { n.h[ev] = fn; };
    // focusVisible: true after keyboard focus, false after a mouse click, null in an engine without :focus-visible.
    n.focusVisible = true;
    n.matches = (sel) => {
      if (sel !== ':focus-visible') throw new Error(`unexpected selector ${sel}`);
      if (n.focusVisible === null) throw new SyntaxError(`'${sel}' is not a valid selector`);
      return n.focusVisible;
    };
    n.closest = (sel) => (sel === '.node' ? n : null);
    // The ticket link inside the node: focusable on its own, and focusin/focusout bubble from it.
    n.link = { dataset: {}, closest: (sel) => (sel === '.node' ? n : null), matches: (sel) => n.matches(sel) };
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

test('hovering the end of a two-hop chain traces both edges, from data-edges alone', () => {
  const page = fakeDag();
  page.run();
  page.nodes.c.h.mouseenter();
  assert.deepEqual(page.paths().map((p) => p.classList.has('lit')), [true, true]);
  assert.deepEqual(Object.keys(page.nodes).filter((k) => page.nodes[k].classList.has('dim')), ['d']);
  page.nodes.a.h.mouseenter();
  assert.deepEqual(page.paths().map((p) => p.classList.has('lit')), [true, true]);
});

test('keyboard focus survives a hover elsewhere', () => {
  const page = fakeDag();
  page.run();
  page.doc.activeElement = page.nodes.c;
  page.nodes.c.h.focusin();
  page.nodes.d.h.mouseenter();
  page.nodes.d.h.mouseleave();
  assert.ok(page.dag.classList.has('focusing'));
  assert.ok(!page.nodes.c.classList.has('dim'));
  assert.ok(page.nodes.d.classList.has('dim'));
  page.doc.activeElement = null;
  page.nodes.c.h.focusout();
  assert.ok(!page.dag.classList.has('focusing'));
});

// A mouse click focuses the node too (nodes are tabindex="0"), but only keyboard focus
// matches :focus-visible and shows a ring, so only keyboard focus keeps the trace on mouseleave.
for (const [how, focusVisible, sticks] of [['keyboard focus', true, true], ['a mouse click', false, false], ['focus without :focus-visible support', null, true]]) {
  test(`after ${how}, mouseleave ${sticks ? 'keeps' : 'clears'} the node's trace`, () => {
    const page = fakeDag();
    page.run();
    page.nodes.c.h.mouseenter();
    page.nodes.c.focusVisible = focusVisible;
    page.doc.activeElement = page.nodes.c;
    page.nodes.c.h.focusin();
    page.nodes.c.h.mouseleave();
    assert.equal(page.dag.classList.has('focusing'), sticks);
    assert.equal(page.nodes.d.classList.has('dim'), sticks);
  });
}

test('tabbing from a node to its own ticket link keeps the node\'s trace', () => {
  const page = fakeDag();
  page.run();
  page.doc.activeElement = page.nodes.c;
  page.nodes.c.h.focusin();
  page.doc.activeElement = null; // during focusout, focus has left c but not yet reached the link
  page.nodes.c.h.focusout();
  page.doc.activeElement = page.nodes.c.link;
  page.nodes.c.h.focusin(); // bubbled up from the link
  page.nodes.d.h.mouseenter();
  page.nodes.d.h.mouseleave();
  assert.ok(page.dag.classList.has('focusing'));
  assert.ok(!page.nodes.c.classList.has('dim'));
  assert.ok(page.nodes.d.classList.has('dim'));
});

test('focus leaving a node restores the trace of the node under the pointer', () => {
  const page = fakeDag();
  page.run();
  page.doc.activeElement = page.nodes.c;
  page.nodes.c.h.focusin();
  page.nodes.d.h.mouseenter();
  page.doc.activeElement = null;
  page.nodes.c.h.focusout();
  assert.ok(page.dag.classList.has('focusing'));
  assert.ok(!page.nodes.d.classList.has('dim'));
  assert.ok(page.nodes.c.classList.has('dim'));
});

test('a lit edge eases into its accent stroke as the others fade', () => {
  const rule = RULES.find((r) => r.sels.includes('.dag path[data-a]') && /transition:/.test(r.body));
  assert.ok(rule, 'the edges carry a transition');
  for (const prop of ['opacity', 'stroke-opacity']) assert.match(rule.body, new RegExp(`(:|,)${prop} `));
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

// ---- burn-up script --------------------------------------------------------

test('the burn-up script parses', async () => {
  const { BURN_JS } = await import('./assets.mjs');
  assert.doesNotThrow(() => new Function(BURN_JS));
});

test('the burn-up script moves the one tab stop with the arrow keys, Home and End, and stops at either end', async () => {
  const { BURN_JS } = await import('./assets.mjs');
  const doc = { activeElement: null };
  const pts = [0, 1, 2].map((i) => ({ i, tabIndex: i === 2 ? 0 : -1, focus() { doc.activeElement = this; } }));
  let onKey;
  const plot = { querySelectorAll: () => pts, addEventListener: (type, fn) => { if (type === 'keydown') { onKey = fn; } } };
  doc.querySelectorAll = (sel) => (sel === '.burn .plot' ? [plot] : []);
  new Function('document', BURN_JS)(doc);
  const press = (key) => { let prevented = false; onKey({ key, preventDefault: () => { prevented = true; } }); return prevented; };
  pts[2].focus();
  assert.equal(press('ArrowRight'), false, 'nothing after the last step');
  assert.equal(press('ArrowLeft'), true);
  assert.equal(doc.activeElement, pts[1]);
  assert.deepEqual(pts.map((p) => p.tabIndex), [-1, 0, -1]);
  press('Home');
  assert.equal(doc.activeElement, pts[0]);
  press('End');
  assert.deepEqual(pts.map((p) => p.tabIndex), [-1, -1, 0]);
  assert.equal(press('a'), false, 'other keys pass through');
});

test('a burn-up tooltip shows on hover or keyboard focus, not after a click leaves a step focused', () => {
  // A click focuses the step it lands on (steps carry tabindex), so a :focus rule would pin that tooltip open beside the one being hovered.
  const tipRule = RULES.find((r) => r.sels.some((s) => s.endsWith('+.tip')));
  assert.deepEqual(tipRule.sels, ['.burn .pt:hover+.tip', '.burn .pt:focus-visible+.tip']);
  assert.ok(!RULES.some((r) => r.sels.some((s) => /\.pt:focus(?!-)/.test(s))), 'no plain :focus rule on a step');
});
