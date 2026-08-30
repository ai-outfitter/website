import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const words = (value) => String(value).replaceAll('-', ' ').replaceAll('_', ' ');
const title = (value) => ({
  'draft-pr': 'Draft PR',
  'pr-undrafted': 'PR undrafted',
}[value] ?? words(value).replace(/\b\w/g, (letter) => letter.toUpperCase()));
const eventName = (value) => ({
  'issues.labeled': 'Issue labeled',
  'issues.opened': 'Issue opened',
  'issues.assigned': 'Issue assigned',
  'pull_request.review_requested': 'Pull request review requested',
  'jmap.Email/new': 'New email received',
}[value] ?? title(String(value).replaceAll(/[./]/g, '-')));
const branchName = (value) => ({
  approve: 'Approved',
  'request-changes': 'Changes requested',
  feat: 'Feature',
  fix: 'Fix',
  research: 'Research',
  'market/competitive': 'Market / competitive',
  'technical/spike': 'Technical spike',
  'business/finance': 'Business / finance',
}[value] ?? title(String(value).replaceAll('/', '-')));
const conditionLabel = (expression) => {
  const equality = String(expression).match(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*==\s*(['"])(.*?)\1$/);
  return equality ? branchName(equality[2]) : 'Condition met';
};
const escapeHtml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const list = (value) => {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`Expected a list, received ${typeof value}`);
  return value.map(String);
};

function assertAcyclic(graph, message) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error(message(id));
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  graph.forEach((_, id) => visit(id));
}

function reachable(graph, id) {
  const seen = new Set();
  const visit = (current) => {
    for (const target of graph.get(current) ?? []) {
      if (seen.has(target)) continue;
      seen.add(target);
      visit(target);
    }
  };
  visit(id);
  return seen;
}

function workflowMap(factory) {
  if (!Array.isArray(factory.workflows)) throw new Error('Factory "workflows" MUST be a list.');
  const workflows = new Map();
  for (const workflow of factory.workflows) {
    if (!workflow?.id) throw new Error('Every workflow MUST have an id.');
    if (!workflow.title) throw new Error(`Workflow "${workflow.id}" MUST have a title.`);
    if (!workflow.description) throw new Error(`Workflow "${workflow.id}" MUST have a description.`);
    if (workflows.has(workflow.id)) throw new Error(`Duplicate workflow id "${workflow.id}".`);
    if (!Array.isArray(workflow.nodes)) throw new Error(`Workflow "${workflow.id}" nodes MUST be a list.`);
    workflows.set(workflow.id, workflow);
  }
  return workflows;
}

function validate(factory, workflows) {
  const invocationGraph = new Map();
  for (const [workflowId, workflow] of workflows) {
    const nodes = new Map();
    for (const node of workflow.nodes) {
      if (!node?.id) throw new Error(`Workflow "${workflowId}" has a node without an id.`);
      if (nodes.has(node.id)) throw new Error(`Workflow "${workflowId}" has duplicate node id "${node.id}".`);
      nodes.set(node.id, node);
    }

    const references = [];
    for (const [nodeId, node] of nodes) {
      const isAction = typeof node.action === 'string';
      const isWorkflow = typeof node.workflow === 'string';
      if (isAction === isWorkflow) throw new Error(`Workflow "${workflowId}" node "${nodeId}" MUST declare exactly one of action or workflow.`);
      if (typeof node.description !== 'string' || !node.description.trim()) throw new Error(`Workflow "${workflowId}" node "${nodeId}" MUST have a description.`);
      const needs = list(node.needs);
      for (const dependency of needs) {
        if (!nodes.has(dependency)) throw new Error(`Workflow "${workflowId}" node "${nodeId}" needs unknown node "${dependency}".`);
      }
      if (node.if) {
        const match = String(node.if).match(/^([A-Za-z0-9_-]+)\./);
        if (!match || !needs.includes(match[1])) throw new Error(`Workflow "${workflowId}" node "${nodeId}" condition MUST reference a node listed in needs.`);
      }
      if (isAction) {
        if (!factory.actors?.[node.actor]) throw new Error(`Workflow "${workflowId}" node "${nodeId}" references unknown actor "${node.actor ?? ''}".`);
        if (!factory.environments?.[node.environment]) throw new Error(`Workflow "${workflowId}" node "${nodeId}" references unknown environment "${node.environment ?? ''}".`);
      } else {
        if (!workflows.has(node.workflow)) throw new Error(`Workflow "${workflowId}" node "${nodeId}" references unknown workflow "${node.workflow}".`);
        const modes = list(workflows.get(node.workflow).modes);
        if (modes.length && !node.mode) throw new Error(`Workflow "${workflowId}" node "${nodeId}" MUST select a mode for workflow "${node.workflow}".`);
        if (node.mode && !modes.includes(String(node.mode))) throw new Error(`Workflow "${workflowId}" node "${nodeId}" references unknown mode "${node.mode}" on workflow "${node.workflow}".`);
        references.push(node.workflow);
      }
      for (const integration of list(node.uses)) {
        if (!factory.integrations?.[integration]) throw new Error(`Workflow "${workflowId}" node "${nodeId}" references unknown integration "${integration}".`);
      }
      if (node.prompt_fragment && !factory.prompt_fragments?.[node.prompt_fragment]) {
        throw new Error(`Workflow "${workflowId}" node "${nodeId}" references unknown prompt fragment "${node.prompt_fragment}".`);
      }
      for (const check of list(node.checks)) {
        if (!factory.checks?.[check]) throw new Error(`Workflow "${workflowId}" node "${nodeId}" references unknown check "${check}".`);
      }
    }

    for (const [index, trigger] of (workflow.triggers ?? []).entries()) {
      if (!factory.integrations?.[trigger.integration]) throw new Error(`Workflow "${workflowId}" trigger ${index} references unknown integration "${trigger.integration}".`);
      if (trigger.environment && !factory.environments?.[trigger.environment]) throw new Error(`Workflow "${workflowId}" trigger ${index} references unknown environment "${trigger.environment}".`);
      if (typeof trigger.description !== 'string' || !trigger.description.trim()) throw new Error(`Workflow "${workflowId}" trigger ${index} MUST have a description.`);
    }

    const dependencyGraph = new Map([...nodes].map(([id, node]) => [id, list(node.needs)]));
    assertAcyclic(dependencyGraph, (id) => `Workflow "${workflowId}" contains a needs cycle at node "${id}".`);
    for (const [index, feedback] of (workflow.feedback ?? []).entries()) {
      if (!feedback?.from || !nodes.has(feedback.from)) throw new Error(`Workflow "${workflowId}" feedback ${index} references unknown source node "${feedback?.from ?? ''}".`);
      if (!feedback?.to || !nodes.has(feedback.to)) throw new Error(`Workflow "${workflowId}" feedback ${index} references unknown target node "${feedback?.to ?? ''}".`);
      if (!feedback.label) throw new Error(`Workflow "${workflowId}" feedback ${index} MUST have a label.`);
      if (!reachable(dependencyGraph, feedback.from).has(feedback.to)) throw new Error(`Workflow "${workflowId}" feedback ${index} target "${feedback.to}" MUST be an ancestor of "${feedback.from}".`);
    }
    invocationGraph.set(workflowId, [...new Set(references)]);
  }

  assertAcyclic(invocationGraph, (id) => `Blocking workflow references contain a cycle at "${id}".`);
  return invocationGraph;
}

const environmentDefinitions = {
  local: { name: 'Local', className: 'local' },
  'agent-operator': { name: 'Kubernetes', className: 'resident' },
  'github-actions': { name: 'GitHub Actions', className: 'actions' },
};
const environmentDefinition = (factory, reference) => environmentDefinitions[factory.environments?.[reference]];
const environmentName = (factory, reference) => environmentDefinition(factory, reference)?.name ?? title(factory.environments?.[reference] ?? reference);
const environmentClass = (factory, reference) => environmentDefinition(factory, reference)?.className ?? 'default';
const actorName = (factory, reference) => `${title(reference)} (${words(factory.actors?.[reference]?.kind ?? 'actor')})`;
const actorKind = (factory, reference) => title(factory.actors?.[reference]?.kind ?? 'actor');

function cardLabel(titleText, rows, description) {
  const descriptionLabel = description ? `<span class='workflow-node-description'>${escapeHtml(description)}</span>` : '';
  return `<span class='workflow-node-card'><span class='workflow-node-title'>${escapeHtml(titleText)}${descriptionLabel}</span>${rows.map((row) => `<span class='workflow-node-meta'>${escapeHtml(row)}</span>`).join('')}</span>`;
}

function actionNode(factory, node) {
  const label = cardLabel(title(node.action), [
    `${actorKind(factory, node.actor)}: ${title(node.actor)}`,
    `Environment: ${environmentName(factory, node.environment)}`,
  ], node.description);
  const wrappers = { action: ['["', '"]'], event: ['("', '")'], decision: ['{"', '"}'], gate: ['{{"', '"}}'] };
  const [open, close] = wrappers[node.shape ?? 'action'] ?? wrappers.action;
  return `  ${node.id}${open}${label}${close}:::${environmentClass(factory, node.environment)}`;
}

function renderWorkflow(factory, workflows, workflow) {
  const lines = ['flowchart LR'];
  const triggers = (workflow.triggers ?? []).map((trigger, index) => {
    const id = `__trigger_${index}`;
    const rows = [`Event: ${trigger.event ? eventName(trigger.event) : factory.integrations[trigger.integration].label ?? title(trigger.integration)}`];
    if (trigger.environment) rows.push(`Environment: ${environmentName(factory, trigger.environment)}`);
    const label = cardLabel('Workflow trigger', rows, trigger.description);
    return { id, mermaid: `  ${id}("${label}"):::${environmentClass(factory, trigger.environment)}` };
  });
  triggers.forEach((trigger) => lines.push(trigger.mermaid));
  workflow.nodes.forEach((node) => {
    if (node.workflow) {
      const target = workflows.get(node.workflow);
      const rows = ['Workflow: Open workflow →'];
      if (node.mode) rows.push(`Mode: ${title(node.mode)}`);
      const label = cardLabel(target.title ?? title(target.id), rows, node.description);
      lines.push(`  ${node.id}[["${label}"]]:::workflowRef`);
    } else lines.push(actionNode(factory, node));
  });
  for (const node of workflow.nodes) {
    for (const dependency of list(node.needs)) {
      const condition = node.if && String(node.if).startsWith(`${dependency}.`) ? `|${escapeHtml(conditionLabel(node.if))}|` : '';
      lines.push(`  ${dependency} -->${condition} ${node.id}`);
    }
  }
  for (const feedback of workflow.feedback ?? []) {
    lines.push(`  ${feedback.from} -. ${escapeHtml(feedback.label)} .-> ${feedback.to}`);
  }
  const roots = workflow.nodes.filter((node) => list(node.needs).length === 0);
  for (const trigger of triggers) for (const root of roots) lines.push(`  ${trigger.id} --> ${root.id}`);
  workflow.nodes
    .filter((node) => node.workflow || factory.actors[node.actor].kind === 'human')
    .forEach((node) => lines.push(`  class ${node.id} ${node.workflow ? 'workflowAction' : 'humanAction'}`));
  lines.push(
    '  classDef local stroke-width:2px',
    '  classDef resident stroke-width:2px',
    '  classDef actions stroke-width:2px',
    '  classDef default stroke-width:2px',
    '  classDef workflowRef stroke-width:3px',
    '  classDef humanAction stroke-dasharray:7 4',
    '  classDef workflowAction stroke-dasharray:4 3',
  );
  return lines.join('\n');
}

function workflowNodeDetails(factory, workflow) {
  const triggers = (workflow.triggers ?? []).map((trigger, index) => ({
    id: `__trigger_${index}`,
    title: 'Workflow trigger',
    kind: 'step',
    details: [
      { label: 'Description', value: trigger.description },
      trigger.source ? { label: 'Source', value: title(trigger.source) } : null,
      trigger.environment ? { label: 'Environment', value: environmentName(factory, trigger.environment) } : null,
      trigger.event ? { label: 'Event', value: eventName(trigger.event) } : null,
      trigger.rule ? { label: 'Rule', value: trigger.rule } : null,
      { label: 'Integration', value: factory.integrations[trigger.integration].label ?? title(trigger.integration) },
    ].filter(Boolean),
  }));
  const nodes = workflow.nodes.map((node) => {
    if (node.workflow) {
      return {
        id: node.id,
        title: title(node.workflow),
        kind: 'workflow',
        href: `/workflows/${node.workflow}/`,
        details: [
          { label: 'Description', value: node.description },
          node.mode ? { label: 'Mode', value: title(node.mode) } : null,
        ].filter(Boolean),
      };
    }
    const details = [
      node.description ? { label: 'Description', value: node.description } : null,
      { label: actorKind(factory, node.actor), value: title(node.actor) },
      { label: 'Environment', value: environmentName(factory, node.environment) },
      factory.actors[node.actor].identity ? { label: 'Identity', value: title(factory.actors[node.actor].identity) } : null,
      node.assignee ? { label: 'Assignee', value: title(node.assignee) } : null,
      node.event ? { label: 'Event', value: eventName(node.event) } : null,
      node.skill ? { label: 'Skill', value: node.skill } : null,
      node.prompt_fragment ? { label: 'Prompt fragment', value: node.prompt_fragment } : null,
      node.label ? { label: 'Label', value: node.label } : null,
      node.rule ? { label: 'Rule', value: node.rule } : null,
      node.path ? { label: 'Path', value: node.path } : null,
      node.checks?.length ? { label: 'Checks', value: node.checks.join(', ') } : null,
      node.uses?.length ? { label: 'Uses', value: node.uses.map((reference) => factory.integrations[reference].label ?? title(reference)).join(', ') } : null,
    ].filter(Boolean);
    return { id: node.id, title: title(node.action), kind: 'step', details };
  });
  return [...triggers, ...nodes];
}

export async function loadWorkflows(source) {
  const yaml = await readFile(source, 'utf8');
  const factory = parse(yaml);
  const workflows = workflowMap(factory);
  const invocationGraph = validate(factory, workflows);
  const revision = createHash('sha256').update(yaml).digest('hex').slice(0, 12);
  const items = [...workflows].map(([id, workflow]) => {
    const invokes = invocationGraph.get(id) ?? [];
    return {
      ...workflow,
      revision,
      mermaid: renderWorkflow(factory, workflows, workflow),
      invokes: invokes.map((target) => ({ id: target, title: workflows.get(target).title ?? title(target) })),
      canInvoke: [...reachable(invocationGraph, id)].filter((target) => !invokes.includes(target)).map((target) => ({ id: target, title: workflows.get(target).title ?? title(target) })),
    };
  });
  return { factory, items, yaml };
}

export { actorName, conditionLabel, environmentName, eventName, title, workflowNodeDetails };
