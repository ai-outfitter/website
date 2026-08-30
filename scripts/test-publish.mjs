import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { repositories, repositoryDirectoryEnvironmentVariable } from '../docs/repositories.mjs';
import { originRepairCommand, repositoryUrl } from './checkout-plan.mjs';
import { productionEnvironment, publishCommands } from './publish-plan.mjs';

const projectRoot = resolve('/tmp/website-publish-test');
const overrides = Object.fromEntries(repositories.map(({ name }) => [
  repositoryDirectoryEnvironmentVariable(name),
  `/tmp/override/${name}`,
]));
const environment = productionEnvironment({
  CLOUDFLARE_API_TOKEN: 'test-token',
  AI_OUTFITTER_REPOS_DIR: '/tmp/override/all',
  AI_OUTFITTER_GIT_BASE_URL: 'https://example.invalid/attacker',
  ...overrides,
  UNRELATED: 'preserved',
}, projectRoot);

assert.equal(environment.AI_OUTFITTER_REPOS_DIR, resolve(projectRoot, '.cache/docs-repositories'));
assert.equal(environment.AI_OUTFITTER_GIT_BASE_URL, 'https://github.com/ai-outfitter');
for (const variable of Object.keys(overrides)) assert.equal(environment[variable], undefined);
assert.equal(environment.CLOUDFLARE_API_TOKEN, 'test-token');
assert.equal(environment.UNRELATED, 'preserved');
assert.deepEqual(publishCommands, [
  ['npm', ['run', 'docs:checkout']],
  ['npm', ['run', 'check']],
  ['npm', ['run', 'build']],
  ['npm', ['run', 'test:analytics']],
  ['npm', ['run', 'test:links']],
  ['npm', ['run', 'test:search']],
  ['npm', ['run', 'test:workflows']],
  ['npm', ['exec', '--', 'wrangler', 'deploy']],
]);

const expectedUrl = repositoryUrl('https://github.com/ai-outfitter', 'outfitter');
assert.equal(expectedUrl, 'https://github.com/ai-outfitter/outfitter.git');
assert.equal(originRepairCommand(expectedUrl, expectedUrl), null);
assert.deepEqual(originRepairCommand('https://example.invalid/outfitter.git', expectedUrl), [
  'remote',
  'set-url',
  'origin',
  expectedUrl,
]);
assert.deepEqual(originRepairCommand(null, expectedUrl), [
  'remote',
  'add',
  'origin',
  expectedUrl,
]);

console.log('Production publish isolation regressions pass.');
