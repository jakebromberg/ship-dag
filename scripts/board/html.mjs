// html.mjs — the board's escaping, enforced by the template instead of by review.
//
// Every value interpolated into an `html` template is escaped, so a GitHub- or
// notes-sourced string cannot reach the page as markup. Only a fragment that is
// already HTML passes through unescaped: the result of another `html` template,
// or a string the caller vouches for with `raw`. The template's own literal text
// is trusted, which is where the page's markup lives.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

class Html {
  constructor(text) { this.text = text; }
  toString() { return this.text; }
}

/** Marks a string as trusted HTML, for a fragment no ticket, note or GitHub field can reach (the inlined stylesheet and script). */
export const raw = (text) => new Html(text);

const fragment = (v) => (v instanceof Html ? v.text : Array.isArray(v) ? v.map(fragment).join('') : esc(v));

/** Escapes every interpolated value (an array is its items, joined with nothing); returns HTML that nests in another template unescaped. */
export const html = (strings, ...values) => raw(strings.reduce((out, s, i) => out + fragment(values[i - 1]) + s));

/** The items joined by `sep`, each escaped unless it is already HTML. The separator is the caller's own literal, inserted as written. */
export const list = (items, sep) => raw(items.map(fragment).join(sep));
