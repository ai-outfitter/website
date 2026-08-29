import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { actorName, environmentName, loadWorkflows, title } from './workflows.mjs';

const source = resolve('docs/workflows/factory.yaml');
const output = resolve('src/content/docs/docs/workflows');
const component = '../../../../components/WorkflowDiagram.astro';
const sourceUrl = 'https://github.com/ai-outfitter/website/blob/main/docs/workflows/factory.yaml';
const editUrl = 'https://github.com/ai-outfitter/website/edit/main/docs/workflows/factory.yaml';
const md = (value) => String(value).replaceAll('|', '\\|');
const links = (items) => items.length ? items.map((item) => `[${item.title}](/docs/workflows/${item.id}/)`).join(', ') : 'None';
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
const cards = (await Promise.all(items.map(async (workflow) => `- [**${workflow.title}**](/docs/workflows/${workflow.id}/) — ${workflow.nodes.length} declared steps${workflow.triggers?.length ? `, triggered by ${workflow.triggers.map((trigger) => `\`${trigger.event ?? trigger.integration}\``).join(', ')}` : ''}.${workflow.status === 'target-state' ? ' **Target state.**' : ''}${(await runGuide(workflow)) ? ` **Runnable** — [run it](/docs/workflows/${workflow.id}/#run-it).` : ''}`))).join('\n');
await writeFile(resolve(output, 'index.md'), `---
title: Workflow atlas
description: YAML-defined maps of how people, agents, environments, and integrations compose across AI Outfitter.
editUrl: ${editUrl}
---

The workflow atlas turns one [validated YAML declaration](${sourceUrl}) into navigable diagrams. Use it to understand who acts, where the work runs, what wakes an agent, and which workflow blocks on another workflow.

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

<WorkflowDiagram title={${JSON.stringify(workflow.title)}} source={${JSON.stringify(workflow.mermaid)}} />
${(await afterDiagram(workflow)) ? `\n${await afterDiagram(workflow)}` : ''}

## Starts when

${triggers}

## Relationships

- **Invokes directly:** ${links(workflow.invokes)}
- **Can invoke transitively:** ${links(workflow.canInvoke)}

## Declared steps

| ID | Action | Actor | Environment | After | Condition |
| --- | --- | --- | --- | --- | --- |
${rows}
${(await runGuide(workflow)) ? `\n## Run it\n\n${await runGuide(workflow)}` : ''}`);
}

console.log(`Generated ${items.length} workflow pages from ${source}.`);
