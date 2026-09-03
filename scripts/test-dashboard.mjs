import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

import { workflowGraphsFromCatalog } from './catalog-workflow-graphs.mjs';

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
assert.match(css, /\.site-account-option/, 'Runtime account options must have a global style selector');
assert.doesNotMatch(css, /\.site-account-option\[[^\]]*astro-/, 'Runtime account-option styles must not require an Astro scope attribute');
for (const selector of ['workflow-card', 'source-table', 'badge']) {
  assert.match(css, new RegExp(`\\.dashboard \\.${selector}(?:[,{:.#\\[])`), `Runtime .${selector} elements must be styled beneath .dashboard`);
  assert.doesNotMatch(css, new RegExp(`\\.${selector}[^,{]*:where\\(\\.astro-`), `Runtime .${selector} selectors must not require an Astro scope attribute`);
}
assert.ok(document.querySelector('#onboarding'), 'The dashboard must include the onboarding wizard');
for (const id of ['onboarding-workflow-choices', 'onboarding-preview', 'onboarding-apply', 'onboarding-playground', 'onboarding-commands', 'onboarding-copy', 'overview-start-link']) {
  assert.ok(document.getElementById(id), `The onboarding wizard must render #${id}`);
}
assert.match(css, /\.dashboard \.workflow-choice(?:[,{:.#\[])/, 'Runtime .workflow-choice elements must be styled beneath .dashboard');
assert.ok(document.querySelector('#installed-workflows'), 'The dashboard must separate installed workflows');
assert.ok(document.querySelector('#implementation-workflows'), 'The dashboard must separate primary implementation profiles');
assert.ok(document.querySelector('#community-workflows'), 'The dashboard must separate community workflows');
assert.equal(document.querySelector('#settings-details'), null, 'The dashboard must not expose a settings.yml disclosure');
assert.equal(document.querySelector('#settings-yaml'), null, 'The dashboard must not render settings.yml contents');
assert.ok(document.querySelector('#manager-workflow-graph'), 'Workflow detail must include the workflow graph');
const workflowCatalog = JSON.parse(await readFile('src/generated/workflow-catalog.json', 'utf8'));
const graphPayload = JSON.parse(document.querySelector('#dashboard-workflow-graphs')?.textContent ?? '{}');
assert.deepEqual(Object.keys(graphPayload).sort(), workflowCatalog.map(({ id }) => id).sort(), 'Dashboard graph coverage must match the installable workflow catalog');
assert.deepEqual(graphPayload, workflowGraphsFromCatalog(workflowCatalog), 'Dashboard graphs must derive from the exact bundled workflow declarations');
for (const [id, graph] of Object.entries(graphPayload)) {
  assert.equal(typeof graph.title, 'string', `${id} must have a graph title`);
  assert.match(graph.source, /^flowchart\s+(LR|TB)\n/, `${id} must have a Mermaid flowchart`);
  assert.ok(Array.isArray(graph.nodes) && graph.nodes.length > 0, `${id} must have graph nodes`);
  assert.ok(Array.isArray(graph.configuration) && graph.configuration.length > 0, `${id} must describe its included configuration`);
  assert.equal(new Set(graph.nodes.map((node) => node.id)).size, graph.nodes.length, `${id} graph node ids must be unique`);
  for (const node of graph.nodes) {
    assert.equal(typeof node.id, 'string', `${id} graph nodes must have ids`);
    assert.ok(graph.source.includes(node.id), `${id} Mermaid must include node ${node.id}`);
  }
}
const founderConfiguration = Object.fromEntries(graphPayload.founder.configuration.map(({ label, items }) => [label, items]));
assert.deepEqual(founderConfiguration.Workflows, ['Adversarial Review', 'Founder']);
assert.deepEqual(founderConfiguration.Agents, ['Code Review', 'Founder']);
assert.deepEqual(founderConfiguration.MCPs, ['GitHub Write']);
assert.deepEqual(founderConfiguration.Skills, ['Code Review']);
assert.deepEqual(founderConfiguration['Prompt fragments'], ['Adversarial Review Practice', 'RFC 2119 Requirements']);
assert.deepEqual(founderConfiguration.Environments, ['Delegated Runtime', 'Local']);

console.log('Dashboard runtime styles are globally available and rooted beneath .dashboard.');
