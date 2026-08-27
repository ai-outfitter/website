import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { loadWorkflows } from './workflows.mjs';

const expected = [
  'factory',
  'adversarial-review',
  'bug-issue',
  'issue-triage',
  'research-triage',
  'grafana-alert',
  'persona-review',
];

const { items } = await loadWorkflows(resolve('docs/workflows/factory.yaml'));
assert.deepEqual(items.map((workflow) => workflow.id), expected);

const dom = new JSDOM('<!doctype html><body></body>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: dom.window.navigator,
});
const { default: mermaid } = await import('mermaid');
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
for (const workflow of items) {
  const parsed = await mermaid.parse(workflow.mermaid);
  assert.equal(parsed.diagramType, 'flowchart-v2');
  await access(resolve(`dist/docs/workflows/${workflow.id}/index.html`));
}

const index = await readFile('dist/docs/workflows/index.html', 'utf8');
assert.match(index, /Workflow atlas/);
assert.match(index, /Declaration is not deployment/);
assert.match(index, /Software factory/);

console.log(`Validated ${items.length} YAML-derived Mermaid workflow pages.`);
