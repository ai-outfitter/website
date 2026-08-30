import { resolve } from 'node:path';

import {
  repositories,
  repositoryDirectoryEnvironmentVariable,
} from '../docs/repositories.mjs';

export const publishCommands = [
  ['npm', ['run', 'docs:checkout']],
  ['npm', ['run', 'check']],
  ['npm', ['run', 'build']],
  ['npm', ['run', 'test:links']],
  ['npm', ['run', 'test:search']],
  ['npm', ['run', 'test:workflows']],
  ['npm', ['exec', '--', 'wrangler', 'deploy']],
];

export function productionEnvironment(source, projectRoot) {
  const environment = { ...source };
  delete environment.AI_OUTFITTER_REPOS_DIR;
  delete environment.AI_OUTFITTER_GIT_BASE_URL;
  for (const repository of repositories) {
    delete environment[repositoryDirectoryEnvironmentVariable(repository.name)];
  }
  environment.AI_OUTFITTER_REPOS_DIR = resolve(projectRoot, '.cache/docs-repositories');
  environment.AI_OUTFITTER_GIT_BASE_URL = 'https://github.com/ai-outfitter';
  return environment;
}
