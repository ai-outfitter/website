import { parse } from 'yaml';

import { environmentName, title, workflowDiagramData } from './workflows.mjs';

const declarationPath = (id) => `workflows/${id}/workflow.yaml`;
const unique = (values) => [...new Set(values)].sort((left, right) => left.localeCompare(right));
const displayName = (value) => title(value)
  .replace(/\bGithub\b/g, 'GitHub')
  .replace(/\bRfc\s*2119\b/g, 'RFC 2119');
const pathNames = (files, pattern) => unique(files.flatMap(({ path }) => path.match(pattern)?.[1] ?? []).map(displayName));
const promptNames = (files) => unique(files.flatMap(({ path }) => {
  const reference = path.match(/^prompts\/([^/]+)\.md$/)?.[1];
  if (!reference) return [];
  const [kind, ...name] = reference.split('.');
  const label = displayName(name.join('-'));
  return kind === 'practice' ? [`${label} Practice`] : [label];
}));

function includedConfiguration(bundle, declarations) {
  const rows = [
    { label: 'Workflows', items: pathNames(bundle.files, /^workflows\/([^/]+)\/workflow\.yaml$/) },
    { label: 'Agents', items: pathNames(bundle.files, /^agents\/([^/]+)\/agent\.md$/) },
    {
      label: 'MCPs',
      items: unique(bundle.files
        .filter(({ path }) => /^agents\/[^/]+\/mcp\.json$/.test(path))
        .flatMap(({ content }) => Object.keys(JSON.parse(content).mcpServers ?? {}))
        .map(displayName)),
    },
    { label: 'Skills', items: pathNames(bundle.files, /^skills\/([^/]+)\/SKILL\.md$/) },
    { label: 'Prompt fragments', items: promptNames(bundle.files) },
    {
      label: 'Environments',
      items: unique(declarations.flatMap(({ declaration }) => Object.keys(declaration.environments ?? {})
        .map((reference) => environmentName(declaration, reference)))),
    },
  ];
  return rows.filter(({ items }) => items.length);
}

export function workflowGraphsFromCatalog(catalog) {
  return Object.fromEntries(catalog.map((bundle) => {
    const declarations = bundle.files
      .filter((file) => /^workflows\/[^/]+\/workflow\.yaml$/.test(file.path))
      .map((file) => ({ path: file.path, declaration: parse(file.content) }));
    const root = declarations.find(({ path }) => path === declarationPath(bundle.id))?.declaration;
    if (!root) throw new Error(`Embedded workflow bundle "${bundle.id}" is missing ${declarationPath(bundle.id)}.`);
    if (root.id !== bundle.id) throw new Error(`Embedded workflow bundle "${bundle.id}" contains declaration "${root.id ?? 'unknown'}".`);
    return [bundle.id, {
      ...workflowDiagramData(root, declarations.map(({ declaration }) => declaration)),
      configuration: includedConfiguration(bundle, declarations),
    }];
  }));
}
