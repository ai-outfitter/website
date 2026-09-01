import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const html = await readFile('dist/dashboard/index.html', 'utf8');
const document = new JSDOM(html).window.document;
const docsHtml = await readFile('dist/docs/index.html', 'utf8');
const stylesheets = [...document.querySelectorAll('link[rel="stylesheet"]')]
  .map((link) => link.getAttribute('href'))
  .filter((href) => href?.endsWith('.css'));
const linkedCss = await Promise.all(stylesheets.map((href) => readFile(resolve('dist', href.slice(1)), 'utf8')));
const inlineCss = [...document.querySelectorAll('style')].map((style) => style.textContent ?? '');
const css = [...linkedCss, ...inlineCss].join('\n');
assert.ok(css, 'The dashboard must contain styles');
assert.equal(document.querySelector('#account'), null, 'The dashboard must not duplicate the active account selector');
assert.equal(document.querySelector('#account-cards'), null, 'The dashboard must not render organization visualizer cards');
assert.equal(document.querySelector('#install-app'), null, 'Add organization must live only in the authenticated navigation');
assert.doesNotMatch(document.querySelector('[data-dashboard]')?.textContent ?? '', /Add organization/, 'The dashboard body must not duplicate the authenticated navigation action');
assert.ok(document.querySelector('meta[name="astro-view-transitions-enabled"]'), 'The dashboard must enable client transitions');
assert.doesNotMatch(docsHtml, /astro-view-transitions-enabled/, 'Static documentation must not enable client transitions');
for (const selector of ['workflow-card', 'source-card', 'badge']) {
  assert.match(css, new RegExp(`\\.dashboard \\.${selector}(?:[,{:.#\\[])`), `Runtime .${selector} elements must be styled beneath .dashboard`);
  assert.doesNotMatch(css, new RegExp(`\\.${selector}[^,{]*:where\\(\\.astro-`), `Runtime .${selector} selectors must not require an Astro scope attribute`);
}
assert.ok(document.querySelector('#installed-workflows'), 'The dashboard must separate installed workflows');
assert.ok(document.querySelector('#community-workflows'), 'The dashboard must separate community workflows');
assert.ok(document.querySelector('#settings-yaml'), 'The dashboard must expose the exact settings.yml content');

console.log('Dashboard runtime styles are globally available and rooted beneath .dashboard.');
