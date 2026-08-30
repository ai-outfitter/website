import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function findOwnerEnvironment() {
  let candidate = projectRoot;
  while (dirname(candidate) !== candidate) {
    const environment = resolve(candidate, '.env');
    if (
      existsSync(environment) &&
      existsSync(resolve(candidate, 'outfitter/README.md'))
    ) {
      return environment;
    }
    candidate = dirname(candidate);
  }
}

function parseEnvironment(path) {
  const parsed = {};
  if (!path) return parsed;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[match[1]] = value;
  }
  return parsed;
}

const env = { ...parseEnvironment(findOwnerEnvironment()), ...process.env };
if (!env.CLOUDFLARE_API_TOKEN) {
  throw new Error(
    'CLOUDFLARE_API_TOKEN is required. Set it in the environment or the AI Outfitter owner .env file.',
  );
}

const providedRepositoriesRoot = Boolean(env.AI_OUTFITTER_REPOS_DIR);
if (!providedRepositoriesRoot) {
  env.AI_OUTFITTER_REPOS_DIR = resolve(projectRoot, '.cache/docs-repositories');
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!providedRepositoriesRoot) run('npm', ['run', 'docs:checkout']);
run('npm', ['run', 'check']);
run('npm', ['run', 'build']);
run('npm', ['run', 'test:links']);
run('npm', ['run', 'test:search']);
run('npm', ['run', 'test:workflows']);
run('npm', ['exec', '--', 'wrangler', 'deploy']);
