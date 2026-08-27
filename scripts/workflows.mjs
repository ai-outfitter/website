import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const words = (value) => String(value).replaceAll('-', ' ').replaceAll('_', ' ');
const title = (value) => ({
  'draft-pr': 'Draft PR',
  'pr-undrafted': 'PR undrafted',
}[value] ?? words(value).replace(/\b\w/g, (letter) => letter.toUpperCase()));
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
        references.push(node.workflow);
      }
      for (const integration of list(node.uses)) {
        if (!factory.integrations?.[integration]) throw new Error(`Workflow "${workflowId}" node "${nodeId}" references unknown integration "${integration}".`);
      }
      for (const check of list(node.checks)) {
        if (!factory.checks?.[check]) throw new Error(`Workflow "${workflowId}" node "${nodeId}" references unknown check "${check}".`);
      }
    }

    for (const [index, trigger] of (workflow.triggers ?? []).entries()) {
      if (!factory.integrations?.[trigger.integration]) throw new Error(`Workflow "${workflowId}" trigger ${index} references unknown integration "${trigger.integration}".`);
      if (trigger.environment && !factory.environments?.[trigger.environment]) throw new Error(`Workflow "${workflowId}" trigger ${index} references unknown environment "${trigger.environment}".`);
    }

    const dependencyGraph = new Map([...nodes].map(([id, node]) => [id, list(node.needs)]));
    assertAcyclic(dependencyGraph, (id) => `Workflow "${workflowId}" contains a needs cycle at node "${id}".`);
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

function integrationLabel(factory, reference) {
  const integration = factory.integrations[reference];
  const kind = { wake: 'Wake', trigger: 'Trigger', mcp: 'MCP', cli: 'CLI', transport: 'Transport' }[integration.kind] ?? title(integration.kind);
  const qualifier = integration.kind === 'mcp' && integration.server ? ` (${escapeHtml(integration.server)})` : '';
  return `${kind} · ${escapeHtml(integration.label ?? reference)}${qualifier}`;
}

function actionNode(factory, node) {
  let label = `<b>${title(node.action)}</b><br/><br/>Actor · ${actorName(factory, node.actor)}<br/>Environment · ${environmentName(factory, node.environment)}`;
  if (node.assignee) label += `<br/>Assignee · ${actorName(factory, node.assignee)}`;
  if (node.event) label += `<br/>Event · ${escapeHtml(node.event)}`;
  if (node.skill) label += `<br/>Skill · ${escapeHtml(node.skill)}`;
  if (node.label) label += `<br/>Label · ${escapeHtml(node.label)}`;
  if (node.rule) label += `<br/>Rule · ${escapeHtml(node.rule)}`;
  if (node.path) label += `<br/>Path · ${escapeHtml(node.path)}`;
  if (node.checks) label += `<br/>Checks · ${node.checks.map(escapeHtml).join(', ')}`;
  for (const reference of list(node.uses)) label += `<br/>${integrationLabel(factory, reference)}`;
  const wrappers = { action: ['["', '"]'], event: ['("', '")'], decision: ['{"', '"}'], gate: ['{{"', '"}}'] };
  const [open, close] = wrappers[node.shape ?? 'action'] ?? wrappers.action;
  return `  ${node.id}${open}${label}${close}:::${environmentClass(factory, node.environment)}`;
}

function renderWorkflow(factory, workflows, workflow) {
  const lines = ['flowchart LR'];
  const triggers = (workflow.triggers ?? []).map((trigger, index) => {
    const id = `__trigger_${index}`;
    let label = '<b>Workflow trigger</b>';
    if (trigger.source) label += `<br/><br/>Source · ${title(trigger.source)}`;
    if (trigger.environment) label += `<br/>Environment · ${environmentName(factory, trigger.environment)}`;
    if (trigger.event) label += `<br/>Event · ${escapeHtml(trigger.event)}`;
    if (trigger.rule) label += `<br/>Rule · ${escapeHtml(trigger.rule)}`;
    label += `<br/>${integrationLabel(factory, trigger.integration)}`;
    return { id, mermaid: `  ${id}("${label}"):::${environmentClass(factory, trigger.environment)}` };
  });
  triggers.forEach((trigger) => lines.push(trigger.mermaid));
  workflow.nodes.forEach((node) => {
    if (node.workflow) {
      const target = workflows.get(node.workflow);
      lines.push(`  ${node.id}[["<b>${escapeHtml(target.title ?? title(target.id))}</b><br/><br/>Workflow · blocks until complete"]]:::workflowRef`);
    } else lines.push(actionNode(factory, node));
  });
  for (const node of workflow.nodes) {
    for (const dependency of list(node.needs)) {
      const condition = node.if && String(node.if).startsWith(`${dependency}.`) ? `|if ${escapeHtml(node.if)}|` : '';
      lines.push(`  ${dependency} -->${condition} ${node.id}`);
    }
  }
  const roots = workflow.nodes.filter((node) => list(node.needs).length === 0);
  for (const trigger of triggers) for (const root of roots) lines.push(`  ${trigger.id} --> ${root.id}`);
  workflow.nodes
    .filter((node) => node.workflow || factory.actors[node.actor].kind === 'human')
    .forEach((node) => lines.push(`  class ${node.id} ${node.workflow ? 'workflowAction' : 'humanAction'}`));
  lines.push(
    '  classDef local fill:#123039,stroke:#71dfd0,color:#e8fffb,stroke-width:2px',
    '  classDef resident fill:#172c4d,stroke:#78a9ff,color:#edf4ff,stroke-width:2px',
    '  classDef actions fill:#302450,stroke:#bc9cff,color:#f5efff,stroke-width:2px',
    '  classDef default fill:#252b38,stroke:#aab7ce,color:#f1f5ff,stroke-width:2px',
    '  classDef workflowRef fill:#202a3d,stroke:#f5c96b,color:#fff8df,stroke-width:3px',
    '  classDef humanAction stroke-dasharray:7 4',
    '  classDef workflowAction stroke-dasharray:4 3',
  );
  return lines.join('\n');
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

export { actorName, environmentName, title };
