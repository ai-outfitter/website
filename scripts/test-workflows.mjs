import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { conditionLabel, eventName, loadWorkflows, workflowNodeDetails } from './workflows.mjs';

const expected = [
  'organization-delegation',
  'founder',
  'engineer',
  'software-factory',
  'adversarial-review',
  'bug-issue',
  'issue-triage',
  'research-triage',
  'grafana-alert',
  'persona-review',
];

const { factory: declaration, items } = await loadWorkflows(resolve('docs/workflows/factory.yaml'));
assert.deepEqual(items.map((workflow) => workflow.id), expected);
assert.ok(items.every((workflow) => workflow.description));
assert.equal(eventName('issues.labeled'), 'Issue labeled');
assert.equal(eventName('pull_request.review_requested'), 'Pull request review requested');
assert.equal(eventName('jmap.Email/new'), 'New email received');
assert.equal(conditionLabel("review.outcome == 'approve'"), 'Approved');
assert.equal(conditionLabel("review.outcome == 'request-changes'"), 'Changes requested');
assert.equal(conditionLabel("classify.kind == 'feat'"), 'Feature');
assert.equal(declaration.integrations.github.server, 'github');
assert.deepEqual(declaration.integrations.github.tools, [
  'issue_read',
  'issue_write',
  'create_pull_request',
  'update_pull_request',
  'pull_request_read',
  'pull_request_review_write',
  'add_comment_to_pending_review',
  'add_issue_comment',
  'merge_pull_request',
]);
assert.equal(declaration.integrations['github-write'], undefined);
assert.equal(declaration.integrations['github-merge'], undefined);

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
  assert.ok(workflow.nodes.every(({ description }) => typeof description === 'string' && description.length > 0));
  assert.ok((workflow.triggers ?? []).every(({ description }) => typeof description === 'string' && description.length > 0));
  assert.equal(
    [...workflow.mermaid.matchAll(/workflow-node-description/g)].length,
    workflow.nodes.length + (workflow.triggers?.length ?? 0),
  );
  const parsed = await mermaid.parse(workflow.mermaid);
  assert.equal(parsed.diagramType, 'flowchart-v2');
  assert.doesNotMatch(workflow.mermaid, /#[0-9a-f]{3,8}/i);
  assert.doesNotMatch(workflow.mermaid, /Uses ·|Checks ·|Rule ·|Identity ·/);
  assert.doesNotMatch(workflow.mermaid, /\((agent|human|tool|system)\)/i);
  assert.doesNotMatch(workflow.mermaid, /\|if [^|]+\|/);
  const details = workflowNodeDetails(declaration, workflow);
  assert.equal(details.length, workflow.nodes.length + (workflow.triggers?.length ?? 0));
  for (const node of details) {
    assert.ok(node.details.some(({ label, value }) => label === 'Description' && value.length > 0));
    if (node.kind === 'workflow') assert.equal(node.href, `/workflows/${workflow.nodes.find(({ id }) => id === node.id).workflow}/`);
    else if (!node.id.startsWith('__trigger_')) assert.ok(node.details.some(({ label }) => ['Agent', 'Human', 'Tool', 'System'].includes(label)));
  }
  const page = resolve(`src/pages/workflows/${workflow.id}.mdx`);
  await access(page);
  const html = await readFile(page, 'utf8');
  assert.doesNotMatch(html, /Declaration is not deployment/);
  assert.doesNotMatch(html, /Declared steps/);
  assert.match(html, new RegExp(workflow.description.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(html, /YAML-derived diagram for the/i);
  assert.doesNotMatch(html, /issues\.(labeled|opened|assigned)|pull_request\.review_requested|jmap\.Email\/new/);
}

const diagramComponent = await readFile('src/components/WorkflowDiagram.astro', 'utf8');
assert.match(diagramComponent, /WorkflowDiagramFrame/);
assert.match(diagramComponent, /installWorkflowDiagrams/);
const diagramFrame = await readFile('src/components/WorkflowDiagramFrame.astro', 'utf8');
assert.match(diagramFrame, /data-workflow-node-dialog/);
assert.match(diagramFrame, /data-workflow-nodes/);

const index = await readFile('src/pages/workflows/index.md', 'utf8');
assert.match(index, /Workflow atlas/);
assert.match(index, /agentic workflow graphs/i);
assert.match(index, /actors responsible for each step/i);
assert.match(index, /environments where they run/i);
assert.doesNotMatch(index, /YAML|declaration/i);
assert.match(index, /class="workflow-card__tags"/);
assert.match(index, /<span>Environment<\/span>Local/);
assert.match(index, /<span>Agent<\/span>Resident Agent/);
assert.doesNotMatch(index, /Declaration is not deployment/);
assert.doesNotMatch(index, /How to read the diagrams|declared steps/i);
assert.match(index, /Software factory/);
assert.match(index, /Organization-wide delegation/);
assert.match(index, /Target state/);
assert.match(index, /class="workflow-grid workflow-grid--delivery"/);
assert.match(index, /A user or organization may use one or more of these workflows to implement features/);
assert.ok(index.indexOf('Founder') < index.indexOf('Supporting workflows'));
assert.ok(index.indexOf('Engineer') < index.indexOf('Supporting workflows'));
assert.ok(index.indexOf('Software factory') < index.indexOf('Supporting workflows'));
assert.doesNotMatch(index, /Edit workflow source/);

const organizationDelegation = items.find((workflow) => workflow.id === 'organization-delegation');
assert.equal(organizationDelegation.status, 'target-state');
assert.deepEqual(organizationDelegation.invokes.map(({ id }) => id), ['issue-triage']);
assert.doesNotMatch(organizationDelegation.mermaid, /Codex/);

const triage = items.find((workflow) => workflow.id === 'issue-triage');
assert.match(triage.mermaid, /Assign Resident Agent/);
assert.match(triage.mermaid, /Bug issue/);
assert.match(triage.mermaid, /Research triage/);
assert.deepEqual(triage.invokes.map(({ id }) => id), ['software-factory', 'bug-issue', 'research-triage']);

const softwareFactory = items.find((workflow) => workflow.id === 'software-factory');
assert.deepEqual(softwareFactory.nodes.map(({ id }) => id), [
  'prepare_issue',
  'assign',
  'worktree',
  'research',
  'implement',
  'draft',
  'ci',
  'ready',
  'auto_merge',
  'review',
  'revise',
  'merge',
]);
assert.equal(softwareFactory.nodes[0].action, 'receive-issue-and-categorize-only-if-untyped');
assert.equal(softwareFactory.nodes.find(({ id }) => id === 'assign').actor, 'resident-agent');
assert.equal(softwareFactory.nodes.find(({ id }) => id === 'assign').needs[0], 'prepare_issue');
assert.ok(softwareFactory.nodes.filter(({ id }) => !['review', 'merge'].includes(id)).every(({ actor }) => actor === 'resident-agent'));
assert.equal(softwareFactory.nodes.find(({ id }) => id === 'ready').needs[0], 'ci');
assert.equal(softwareFactory.nodes.find(({ id }) => id === 'review').workflow, 'adversarial-review');
assert.equal(softwareFactory.nodes.find(({ id }) => id === 'review').mode, 'github-codeowners');
assert.equal(softwareFactory.nodes.find(({ id }) => id === 'merge').actor, 'github-platform');
assert.match(softwareFactory.mermaid, /revise -\. rerun CI and CODEOWNERS review \.-> ci/);

const founder = items.find((workflow) => workflow.id === 'founder');
assert.ok(founder.nodes.filter(({ workflow }) => !workflow).every(({ actor, environment }) => actor === 'founder-agent' && environment === 'workstation'));
assert.equal(declaration.actors['founder-agent'].identity, 'human');
assert.equal(founder.nodes.find(({ id }) => id === 'work').action, 'iterate');
assert.match(founder.nodes.find(({ id }) => id === 'work').description, /main by default/);
assert.match(founder.mermaid, /workflow-node-description.*Work on main by default/);
assert.ok(workflowNodeDetails(declaration, founder).find(({ id }) => id === 'work').details.some(({ label, value }) => label === 'Description' && /worktree/.test(value)));
assert.equal(founder.nodes.find(({ id }) => id === 'commit').needs[0], 'verify');
assert.equal(founder.nodes.find(({ id }) => id === 'review').needs[0], 'commit');
assert.equal(founder.nodes.find(({ id }) => id === 'review').mode, 'local');
assert.equal(founder.nodes.find(({ id }) => id === 'push').needs[0], 'review');
assert.match(founder.mermaid, /review -->\|Approved\| push/);
assert.deepEqual(founder.invokes.map(({ id }) => id), ['adversarial-review']);

const engineer = items.find((workflow) => workflow.id === 'engineer');
const adversarial = items.find((workflow) => workflow.id === 'adversarial-review');
// Invariants, not the YAML restated: every engineer step is the human-identity
// local agent except the merge, which a human owns; the review invokes
// adversarial-review in a mode that workflow declares; some review node emits
// the outcome the branch conditions read; both verdict branches render.
assert.equal(declaration.actors['engineer-agent'].identity, 'human');
assert.ok(engineer.nodes.filter(({ workflow, id }) => !workflow && id !== 'merge').every(({ actor, environment }) => actor === 'engineer-agent' && environment === 'workstation'));
assert.equal(declaration.actors[engineer.nodes.find(({ id }) => id === 'merge').actor].kind, 'human');
assert.deepEqual(engineer.invokes.map(({ id }) => id), ['adversarial-review']);
assert.ok(adversarial.modes.includes(engineer.nodes.find(({ id }) => id === 'review').mode));
assert.ok(adversarial.nodes.some(({ outputs }) => outputs?.includes('outcome')));
assert.match(engineer.mermaid, /review -->\|Changes requested\| revise/);
assert.match(engineer.mermaid, /review -->\|Approved\| merge/);
assert.notEqual(adversarial.nodes[0].actor, 'resident-agent');
assert.notEqual(adversarial.nodes[0].actor, 'engineer-agent');

const grafana = items.find((workflow) => workflow.id === 'grafana-alert');
assert.deepEqual(grafana.nodes.map(({ id }) => id), ['investigate', 'issue', 'triage']);
assert.match(grafana.mermaid, /Create Fix Issue/);
assert.deepEqual(grafana.invokes.map(({ id }) => id), ['issue-triage']);

async function publicFiles(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? publicFiles(resolve(path, entry.name)) : [resolve(path, entry.name)]));
  return nested.flat();
}
const publicPaths = [
  ...(await publicFiles('docs/workflows')),
  ...(await publicFiles('src/pages/workflows')),
  resolve('src/content/docs/index.mdx'),
  resolve('src/content/docs/docs/start.md'),
];
const staleDeliveryReference = /\bid:\s*factory\b|\/docs\/workflows\/factory\/|merge-bot|human_decision|same identity|revises once|one fresh second review/i;
for (const path of publicPaths) assert.doesNotMatch(await readFile(path, 'utf8'), staleDeliveryReference, path);
await assert.rejects(access('src/content/docs/docs/workflows/index.md'));

console.log(`Validated ${items.length} workflow declarations and generated source pages.`);
