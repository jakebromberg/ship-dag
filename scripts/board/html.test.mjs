// Tests for the board's html template: every interpolated value is escaped unless it is a
// fragment the template or `raw` produced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html, raw, list } from './html.mjs';

const evil = `<b onclick="x">&'`;
const escaped = '&lt;b onclick=&quot;x&quot;&gt;&amp;&#39;';

for (const [name, got, want] of [
  ['a string', html`<i>${evil}</i>`, `<i>${escaped}</i>`],
  ['a number', html`<i>${7}</i>`, '<i>7</i>'],
  ['null and undefined, as nothing', html`<i>${null}${undefined}</i>`, '<i></i>'],
  ['a raw fragment, untouched', html`<i>${raw('<u>x</u>')}</i>`, '<i><u>x</u></i>'],
  ['a nested template, not escaped twice', html`<i>${html`<u>${evil}</u>`}</i>`, `<i><u>${escaped}</u></i>`],
  ['an array, joined without a separator', html`<ul>${['a', '<', html`<li>`].map((x) => x)}</ul>`, '<ul>a&lt;<li></ul>'],
  ['a list with a separator, items escaped', html`${list(['a', evil, html`<u>`], ', ')}`, `a, ${escaped}, <u>`],
  ['an empty list', html`<i>${list([], ', ')}</i>`, '<i></i>'],
]) {
  test(`html escapes ${name}`, () => assert.equal(String(got), want));
}

test('a template\'s own text is trusted, and a plain string handed back in is not', () => {
  const fragment = '<u>x</u>';
  assert.equal(String(html`<p>${fragment}</p>`), '<p>&lt;u&gt;x&lt;/u&gt;</p>');
});
