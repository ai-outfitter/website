import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { repositories } from '../docs/repositories.mjs';
import { originRepairCommand, repositoryUrl } from './checkout-plan.mjs';

const destinationRoot = resolve(
  process.env.AI_OUTFITTER_REPOS_DIR || '.cache/docs-repositories',
);
const gitBaseUrl = process.env.AI_OUTFITTER_GIT_BASE_URL || 'git@github.com:ai-outfitter';
await mkdir(destinationRoot, { recursive: true });

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'inherit' });
}

for (const { name } of repositories) {
  const destination = resolve(destinationRoot, name);
  const expectedUrl = repositoryUrl(gitBaseUrl, name);
  if (!existsSync(resolve(destination, '.git'))) {
    git(destinationRoot, 'clone', expectedUrl, name);
  } else {
    const dirty = execFileSync('git', ['status', '--porcelain'], {
      cwd: destination,
      encoding: 'utf8',
    }).trim();
    if (dirty) throw new Error(`${destination} has local changes; refusing to replace them.`);
    let currentUrl;
    try {
      currentUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: destination,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      currentUrl = null;
    }
    const repair = originRepairCommand(currentUrl, expectedUrl);
    if (repair) git(destination, ...repair);
    git(destination, 'fetch', '--prune', 'origin');
    git(destination, 'switch', '--detach', 'origin/main');
  }
}

console.log(`Repository documentation checkouts are ready in ${destinationRoot}.`);
