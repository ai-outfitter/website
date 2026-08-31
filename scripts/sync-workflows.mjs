import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { environmentName, eventName, loadWorkflows, title, workflowNodeDetails } from './workflows.mjs';

const source = resolve('docs/workflows/factory.yaml');
const output = resolve('src/pages/workflows');
const component = '../../components/WorkflowDiagram.astro';
const layout = '../../layouts/WorkflowPage.astro';
const yamlQuote = (value) => JSON.stringify(String(value).replaceAll(/\s+/g, ' ').trim());

const { factory, items } = await loadWorkflows(source);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

// A workflow with a `<id>.run.md` beside its YAML is runnable today: that
// file is the walkthrough for running it on a real repository, and the
// generated page carries it under "Run it".
const runGuide = (workflow) => {
  const path = resolve(dirname(source), `${workflow.id}.run.md`);
  return existsSync(path) ? readFile(path, 'utf8') : null;
};
const afterDiagram = (workflow) => {
  const path = resolve(dirname(source), `${workflow.id}.after-diagram.md`);
  return existsSync(path) ? readFile(path, 'utf8') : null;
};
const workflowTags = (workflow) => {
  const environments = [...new Set([
    ...workflow.nodes.filter((node) => node.environment).map((node) => environmentName(factory, node.environment)),
    ...(workflow.triggers ?? []).filter((trigger) => trigger.environment).map((trigger) => environmentName(factory, trigger.environment)),
  ])].map((value) => ({ label: 'Environment', value }));
  const actors = [...new Set(workflow.nodes.filter((node) => node.actor).map((node) => node.actor))]
    .map((reference) => ({ label: title(factory.actors[reference].kind), value: title(reference) }));
  return [...environments, ...actors];
};
const card = async (workflow) => {
  const metadata = [
    workflow.triggers?.length ? `Triggered by ${workflow.triggers.map((trigger) => trigger.event ? eventName(trigger.event) : title(trigger.integration)).join(', ')}` : null,
    workflow.status === 'target-state' ? 'Target state' : null,
    (await runGuide(workflow)) ? 'Runnable' : null,
  ].filter(Boolean).join(' · ');
  const summary = workflow.description;
  const tags = workflowTags(workflow).map(({ label, value }) => `<li><span>${label}</span>${value}</li>`).join('\n    ');
  return `<a class="workflow-card" data-workflow-id="${workflow.id}" href="/workflows/${workflow.id}/">
  <span class="workflow-card__meta">${metadata || 'Workflow'}</span>
  <h3>${workflow.title}</h3>
  <p>${summary}</p>
  <ul class="workflow-card__tags" aria-label="Actors and environments">
    ${tags}
  </ul>
  <span class="workflow-card__action">Open workflow →</span>
</a>`;
};
const deliveryIds = new Set(['founder', 'engineer', 'software-factory']);
const deliveryCards = (await Promise.all(items.filter((workflow) => deliveryIds.has(workflow.id)).map(card))).join('\n');
const supportingCards = (await Promise.all(items.filter((workflow) => !deliveryIds.has(workflow.id)).map(card))).join('\n');
await writeFile(resolve(output, 'index.md'), `---
layout: ${layout}
title: Workflow atlas
description: Agentic workflow graphs you can inspect, evaluate, and adopt for your own work or organization.
---

Compare the actors responsible for each step, the environments where they run, the events that start work, and the handoffs between workflows. Open any graph to inspect its operating model and evaluate what fits your work or organization.

<section class="workflow-section workflow-section--delivery">
  <h2>Implement features</h2>
  <p>A user or organization may use one or more of these workflows to implement features, depending on where the work runs and how much of the delivery loop is delegated.</p>
  <div class="workflow-grid workflow-grid--delivery">
${deliveryCards}
  </div>
</section>

<section class="workflow-section">
  <h2>Supporting workflows</h2>
  <p>Compose delivery with delegation, triage, incident response, research, persona review, and adversarial review.</p>
  <div class="workflow-grid">
${supportingCards}
  </div>
</section>
`);


// Every agent profile a workflow's steps run as. The dashboard installs
// these into an organization's or user's `.agents` repository — pushed to
// the default branch or opened as a pull request — so a reader can adopt a
// workflow's agents from the page that describes it.
const STORE_URL = '/dashboard/';
const agentProfiles = (workflow) => [...new Set(workflow.nodes
  .filter((node) => !node.workflow && factory.actors[node.actor]?.kind === 'agent' && factory.actors[node.actor].profile)
  .map((node) => factory.actors[node.actor].profile))];
const installSection = (workflow) => {
  const profiles = agentProfiles(workflow);
  if (!profiles.length) return '';
  return `\n## Install the agents\n\nThis workflow runs as ${profiles.map((profile) => `\`${profile}\``).join(', ')}. [Manage this workflow's agent bundle](${STORE_URL}?workflow=${workflow.id}): choose an existing managed repository, preview the exact structured changes, then open a pull request or commit to its default branch.\n`;
};

for (const workflow of items) {
  const triggers = workflow.triggers?.length
    ? workflow.triggers.map((trigger) => `- **${trigger.event ? eventName(trigger.event) : title(trigger.integration)}** via ${factory.integrations[trigger.integration].label ?? trigger.integration}${trigger.rule ? ` when \`${trigger.rule}\`` : ''}${trigger.environment ? ` in ${environmentName(factory, trigger.environment)}` : ''}`).join('\n')
    : null;
  await writeFile(resolve(output, `${workflow.id}.mdx`), `---
layout: ${layout}
title: ${yamlQuote(workflow.title)}
description: ${yamlQuote(workflow.description)}
workflowId: ${yamlQuote(workflow.id)}
---

import WorkflowDiagram from '${component}';

<WorkflowDiagram title={${JSON.stringify(workflow.title)}} source={${JSON.stringify(workflow.mermaid)}} nodes={${JSON.stringify(workflowNodeDetails(factory, workflow))}} />
${(await afterDiagram(workflow)) ? `\n${await afterDiagram(workflow)}` : ''}
${triggers ? `\n## Starts when\n\n${triggers}\n` : ''}
${installSection(workflow)}${(await runGuide(workflow)) ? `\n## Run it\n\n${await runGuide(workflow)}` : ''}`);
}

console.log(`Generated ${items.length} workflow pages from ${source}.`);
