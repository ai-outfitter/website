import { parse } from 'yaml';

import { workflowDiagramData } from './workflows.mjs';

const declarationPath = (id) => `workflows/${id}/workflow.yaml`;

export function workflowGraphsFromCatalog(catalog) {
  return Object.fromEntries(catalog.map((bundle) => {
    const declarations = bundle.files
      .filter((file) => /^workflows\/[^/]+\/workflow\.yaml$/.test(file.path))
      .map((file) => ({ path: file.path, declaration: parse(file.content) }));
    const root = declarations.find(({ path }) => path === declarationPath(bundle.id))?.declaration;
    if (!root) throw new Error(`Embedded workflow bundle "${bundle.id}" is missing ${declarationPath(bundle.id)}.`);
    if (root.id !== bundle.id) throw new Error(`Embedded workflow bundle "${bundle.id}" contains declaration "${root.id ?? 'unknown'}".`);
    return [bundle.id, workflowDiagramData(root, declarations.map(({ declaration }) => declaration))];
  }));
}
