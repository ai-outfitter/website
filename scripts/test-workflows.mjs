import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { loadWorkflows } from './workflows.mjs';

const expected = [
  'adversarial-review',
  'bug-issue',
  'factory',
  'grafana-alert',
  'issue-triage',
  'persona-review',
  'research-triage',
];

const workflowsDirectory = resolve('docs/workflows');
const { items } = await loadWorkflows(workflowsDirectory);
assert.deepEqual(items.map((workflow) => workflow.id), expected);
assert.deepEqual(
  items.map((workflow) => workflow.sourceFile),
  expected.map((id) => `${id}.yaml`),
);
assert.deepEqual(
  items.find((workflow) => workflow.id === 'grafana-alert').workflowLinks,
  [{ nodeId: 'triage', href: '/docs/workflows/issue-triage/', title: 'Issue triage' }],
);

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
const deploymentNotice = /Declaration is not deployment|does not prove that every|not proof that every runtime control|describes (?:declared|intended) behavior/i;
assert.match(index, /Workflow atlas/);
assert.match(index, /Software factory/);
assert.match(index, /validated YAML declarations/);
assert.doesNotMatch(index, deploymentNotice);

for (const workflow of items) {
  const page = await readFile(`dist/docs/workflows/${workflow.id}/index.html`, 'utf8');
  assert.doesNotMatch(page, deploymentNotice);
}

const factory = await readFile('dist/docs/workflows/factory/index.html', 'utf8');
assert.match(factory, /docs\/workflows\/factory\.yaml/);
assert.match(factory, /data-workflow-source/);

const grafana = await readFile('dist/docs/workflows/grafana-alert/index.html', 'utf8');
const grafanaDocument = new JSDOM(grafana).window.document;
const grafanaLinks = JSON.parse(grafanaDocument.querySelector('[data-workflow-links]').dataset.workflowLinks);
assert.deepEqual(grafanaLinks, [
  { nodeId: 'triage', href: '/docs/workflows/issue-triage/', title: 'Issue triage' },
]);

const homepage = await readFile('dist/index.html', 'utf8');
const homepageDocument = new JSDOM(homepage).window.document;
assert.match(homepage, /Explore how work moves/);
assert.match(homepage, /aria-label="Workflow diagrams"/);
assert.match(homepage, /data-workflow-diagram/);
assert.match(homepage, /\/docs\/workflows\/factory\//);
assert.equal(homepageDocument.querySelectorAll('[role="tab"]').length, items.length);
assert.equal(homepageDocument.querySelectorAll('[role="tabpanel"]').length, items.length);
assert.equal(homepageDocument.querySelectorAll('[data-workflow-defer]').length, items.length - 1);
assert.doesNotMatch(homepage, deploymentNotice);

const registry = `version: 2
actors:
  bot: {kind: agent}
environments:
  local: local
integrations: {}
checks: {}
`;

async function assertInvalid(files, pattern) {
  const directory = await mkdtemp(join(tmpdir(), 'ai-outfitter-workflows-'));
  try {
    await writeFile(join(directory, 'registry.yaml'), registry);
    await Promise.all(Object.entries(files).map(([filename, source]) =>
      writeFile(join(directory, filename), source)
    ));
    await assert.rejects(loadWorkflows(directory), pattern);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await assertInvalid({
  'wrong.yaml': 'id: right\ntitle: Right\nnodes: []\n',
}, /MUST declare id "wrong"/);

await assertInvalid({
  'same.yaml': 'id: same\ntitle: Same\nnodes: []\n',
  'same.yml': 'id: same\ntitle: Same again\nnodes: []\n',
}, /Duplicate workflow id "same"/);

await assertInvalid({
  'unknown-actor.yaml': `id: unknown-actor
title: Unknown actor
nodes:
  - {id: run, action: run, actor: missing, environment: local}
`,
}, /references unknown actor "missing"/);

await assertInvalid({
  'parent.yaml': `id: parent
title: Parent
nodes:
  - {id: child, workflow: missing}
`,
}, /references unknown workflow "missing"/);

await assertInvalid({
  'a.yaml': `id: a
title: A
nodes:
  - {id: call-b, workflow: b}
`,
  'b.yaml': `id: b
title: B
nodes:
  - {id: call-a, workflow: a}
`,
}, /Blocking workflow references contain a cycle/);

console.log(`Validated ${items.length} YAML-derived Mermaid workflow pages.`);
