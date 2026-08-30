import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parse } from "yaml";

const declaration = parse(await readFile("docs/workflows/factory.yaml", "utf8"));
const actors = declaration.actors ?? {};
const workflows = new Map((declaration.workflows ?? []).map((workflow) => [workflow.id, workflow]));

function resourcesFor(id, seen = new Set()) {
  if (seen.has(id)) return [];
  seen.add(id);
  const workflow = workflows.get(id);
  if (!workflow) return [];
  const resources = new Set();
  for (const node of workflow.nodes ?? []) {
    const actor = actors[node.actor] ?? {};
    if (actor.profile) resources.add(`agents/${actor.profile}`);
    for (const skill of [...(actor.skills ?? []), ...(node.skills ?? []), ...(node.skill ? [node.skill] : [])]) resources.add(`skills/${skill}`);
    for (const prompt of [node.prompt_fragment, ...(node.prompt_fragments ?? [])].filter(Boolean)) resources.add(`prompts/${prompt}`);
    if (node.workflow) for (const resource of resourcesFor(node.workflow, seen)) resources.add(resource);
  }
  return [...resources].sort();
}

const catalog = [...workflows.values()].map((workflow) => ({ id: workflow.id, title: workflow.title, description: workflow.description, resources: resourcesFor(workflow.id) }));
await mkdir("src/generated", { recursive: true });
await writeFile("src/generated/workflow-catalog.json", `${JSON.stringify(catalog, null, 2)}\n`);
