// assets.mjs — the status board's stylesheet and browser script, inlined into
// every page so the board stays one self-contained local file.
//
// They live as real files (page.css, road.js) so they read, lint and diff as CSS
// and JS; this module only loads them once, at import.

import { readFileSync } from 'node:fs';

const load = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');

/** The page stylesheet: light/dark tokens and every component's rules. */
export const PAGE_CSS = load('./page.css');

/** The road-ahead script: draws dependency edges and traces a ticket's chain on hover or focus. */
export const ROAD_JS = load('./road.js');
