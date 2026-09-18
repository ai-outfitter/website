import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureStripeCatalog, stripeWorkerSecrets } from './stripe-setup.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function findOwnerEnvironment() {
  let candidate = projectRoot;
  while (dirname(candidate) !== candidate) {
    const environment = resolve(candidate, '.env');
    if (existsSync(environment) && existsSync(resolve(candidate, 'outfitter/README.md'))) return environment;
    candidate = dirname(candidate);
  }
  return null;
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    parsed[match[1]] = value;
  }
  return parsed;
}

function putWorkerSecret(name, value, environment) {
  const result = spawnSync('npm', ['exec', '--', 'wrangler', 'secret', 'put', name], {
    cwd: projectRoot,
    env: environment,
    input: `${value}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not configure Worker secret ${name}`);
}

if (!process.argv.slice(2).includes('--live')) throw new Error('Refusing to modify Stripe or Cloudflare without the explicit --live flag');

const values = { ...parseEnvironment(findOwnerEnvironment()), ...process.env };
const stripeSecretKey = values.STRIPE_SECRET_KEY?.trim();
const auditabilityMonthlyCents = values.AUDITABILITY_MONTHLY_CENTS?.trim();
if (!stripeSecretKey || !/^[sr]k_live_/.test(stripeSecretKey)) throw new Error('STRIPE_SECRET_KEY must be a live Stripe secret or restricted key');
if (!values.CLOUDFLARE_API_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is required to configure the production Worker');

const catalog = await ensureStripeCatalog(stripeSecretKey, { liveMode: true, auditabilityMonthlyCents });
console.log('Resident: $20/month (ready)');
console.log('Provider cost: $0.000001 per metered microdollar (ready)');
console.log('Markup: $0.000001 per metered microdollar (ready)');
console.log(`Enterprise auditability: $${(Number(auditabilityMonthlyCents) / 100).toFixed(2)}/resident/month (ready)`);
console.log(`No-markup promotion code: ${catalog.promotionCode} (ready)`);

const environment = { ...process.env, CLOUDFLARE_API_TOKEN: values.CLOUDFLARE_API_TOKEN };
delete environment.CLOUDFLARE_ENV;
for (const [name, value] of Object.entries(stripeWorkerSecrets(stripeSecretKey, catalog))) putWorkerSecret(name, value, environment);
console.log('Stripe catalog and production Worker secrets are configured.');
