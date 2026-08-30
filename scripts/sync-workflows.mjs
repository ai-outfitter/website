import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { actorName, environmentName, loadWorkflows, title } from './workflows.mjs';

const source = resolve('docs/workflows');
const output = resolve('src/content/docs/docs/workflows');
const component = '../../../../components/WorkflowDiagram.astro';
const sourceRootUrl = 'https://github.com/ai-outfitter/website/tree/main/docs/workflows';
const registryEditUrl = 'https://github.com/ai-outfitter/website/edit/main/docs/workflows/registry.yaml';
const md = (value) => String(value).replaceAll('|', '\\|');
const links = (items) => items.length ? items.map((item) => `[${item.title}](/docs/workflows/${item.id}/)`).join(', ') : 'None';
const yamlQuote = (value) => JSON.stringify(String(value).replaceAll(/\s+/g, ' ').trim());

const { factory, items } = await loadWorkflows(source);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const displayItems = [...items].sort((left, right) =>
  left.id === 'factory' ? -1 : right.id === 'factory' ? 1 : left.title.localeCompare(right.title)
);
const cards = displayItems.map((workflow) => `- [**${workflow.title}**](/docs/workflows/${workflow.id}/) — ${workflow.nodes.length} declared steps${workflow.triggers?.length ? `, triggered by ${workflow.triggers.map((trigger) => `\`${trigger.event ?? trigger.integration}\``).join(', ')}` : ''}.`).join('\n');
await writeFile(resolve(output, 'index.md'), `---
title: Workflow atlas
description: YAML-defined maps of how people, agents, environments, and integrations compose across AI Outfitter.
editUrl: ${registryEditUrl}
---

The workflow atlas turns [validated YAML declarations](${sourceRootUrl}) into navigable diagrams. Use it to understand who acts, where the work runs, what wakes an agent, and which workflow blocks on another workflow.

## Workflows

${cards}

## How to read the diagrams

- A solid border identifies an agent action; a widely dashed border identifies a human action.
- Teal nodes run locally, blue nodes run in Agent Operator on Kubernetes, and purple nodes run in GitHub Actions.
- A gold, double-edged node is another blocking workflow. Open its linked page for that workflow's steps.
- Diamonds and branches show decisions and their declared conditions.

The step table beneath each diagram carries the same information in text for accessibility and precise review.
`);

for (const workflow of items) {
  const sourceUrl = `https://github.com/ai-outfitter/website/blob/main/docs/workflows/${workflow.sourceFile}`;
  const editUrl = `https://github.com/ai-outfitter/website/edit/main/docs/workflows/${workflow.sourceFile}`;
  const triggers = workflow.triggers?.length
    ? workflow.triggers.map((trigger) => `- **${trigger.event ?? title(trigger.integration)}** via ${factory.integrations[trigger.integration].label ?? trigger.integration}${trigger.rule ? ` when \`${trigger.rule}\`` : ''}${trigger.environment ? ` in ${environmentName(factory, trigger.environment)}` : ''}`).join('\n')
    : '- This workflow has no automatic trigger in the declaration. A person or another workflow starts it.';
  const rows = workflow.nodes.map((node) => {
    const operation = node.workflow ? `[Workflow: ${factory.workflows.find((item) => item.id === node.workflow).title}](/docs/workflows/${node.workflow}/)` : title(node.action);
    const actor = node.workflow ? 'Blocking workflow' : actorName(factory, node.actor);
    const environment = node.workflow ? '—' : environmentName(factory, node.environment);
    const after = node.needs?.length ? node.needs.map((dependency) => `\`${dependency}\``).join(', ') : 'Start';
    const condition = node.if ? `\`${md(node.if)}\`` : '—';
    return `| \`${node.id}\` | ${operation} | ${actor} | ${environment} | ${after} | ${condition} |`;
  }).join('\n');
  await writeFile(resolve(output, `${workflow.id}.mdx`), `---
title: ${yamlQuote(workflow.title)}
description: ${yamlQuote(`YAML-derived diagram and step reference for the ${workflow.title} workflow.`)}
editUrl: ${editUrl}
---

import WorkflowDiagram from '${component}';

This page is generated from the [AI Outfitter workflow declaration](${sourceUrl}) with declaration hash \`${workflow.revision}\`. Edit the YAML—not this generated page—to change the workflow.

<WorkflowDiagram title={${JSON.stringify(workflow.title)}} source={${JSON.stringify(workflow.mermaid)}} links={${JSON.stringify(workflow.workflowLinks)}} />

## Starts when

${triggers}

## Relationships

- **Invokes directly:** ${links(workflow.invokes)}
- **Can invoke transitively:** ${links(workflow.canInvoke)}

## Declared steps

| ID | Action | Actor | Environment | After | Condition |
| --- | --- | --- | --- | --- | --- |
${rows}
`);
}

console.log(`Generated ${items.length} workflow pages from separate declarations in ${source}.`);
