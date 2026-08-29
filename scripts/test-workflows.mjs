import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { loadWorkflows } from './workflows.mjs';

const expected = [
  'organization-delegation',
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
assert.match(index, /Organization-wide delegation/);
assert.match(index, /Target state/);

const homepage = await readFile('dist/index.html', 'utf8');
assert.match(homepage, /Agentic workflows/);
assert.match(homepage, /Rollout/);
assert.match(homepage, /Software factory/);
assert.match(homepage, /Organization-wide delegation/);
assert.match(homepage, /org\/.agents/);
assert.match(homepage, /subagent-delegation/);
assert.match(homepage, /Pi/);
assert.match(homepage, /Claude Code/);
assert.match(homepage, /href="\/docs\/workflows\/issue-triage\/"/);

const organizationDelegation = items.find((workflow) => workflow.id === 'organization-delegation');
assert.equal(organizationDelegation.status, 'target-state');
assert.deepEqual(organizationDelegation.invokes.map(({ id }) => id), ['issue-triage']);
assert.doesNotMatch(organizationDelegation.mermaid, /Codex/);

const triage = items.find((workflow) => workflow.id === 'issue-triage');
assert.match(triage.mermaid, /Assign Resident Agent/);
assert.match(triage.mermaid, /Add Ai Outfitter Label/);
assert.match(triage.mermaid, /Bug issue/);
assert.match(triage.mermaid, /Research triage/);

const factory = items.find((workflow) => workflow.id === 'factory');
assert.deepEqual(factory.nodes.map(({ id }) => id), ['implement', 'ready', 'review', 'revise', 'merge']);

console.log(`Validated ${items.length} YAML-derived Mermaid workflow pages.`);
