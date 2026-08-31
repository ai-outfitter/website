import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const html = await readFile('dist/dashboard/index.html', 'utf8');
const document = new JSDOM(html).window.document;
const stylesheets = [...document.querySelectorAll('link[rel="stylesheet"]')]
  .map((link) => link.getAttribute('href'))
  .filter((href) => href?.endsWith('.css'));
const linkedCss = await Promise.all(stylesheets.map((href) => readFile(resolve('dist', href.slice(1)), 'utf8')));
const inlineCss = [...document.querySelectorAll('style')].map((style) => style.textContent ?? '');
const css = [...linkedCss, ...inlineCss].join('\n');
assert.ok(css, 'The dashboard must contain styles');
for (const selector of ['account-card', 'workflow-card', 'resource-card', 'badge']) {
  assert.match(css, new RegExp(`\\.dashboard \\.${selector}(?:[,{:.#\\[])`), `Runtime .${selector} elements must be styled beneath .dashboard`);
  assert.doesNotMatch(css, new RegExp(`\\.${selector}[^,{]*:where\\(\\.astro-`), `Runtime .${selector} selectors must not require an Astro scope attribute`);
}

console.log('Dashboard runtime styles are globally available and rooted beneath .dashboard.');
