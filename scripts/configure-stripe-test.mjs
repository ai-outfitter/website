import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureStripeCatalog, stripeWorkerSecrets } from './stripe-setup.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const environmentPath = resolve(projectRoot, '.dev.vars');
const retired = new Set(['STRIPE_INDIVIDUAL_PRICE_ID', 'STRIPE_TEAM_PRICE_ID']);

function parse(lines) {
  const values = {};
  for (const line of lines) {
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

function safeValue(value) {
  if (!value || /[\r\n]/.test(value)) throw new Error('Refusing to write an invalid local environment value');
  return value;
}

function updateEnvironment(source, replacements) {
  const seen = new Set();
  const output = [];
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/);
    const name = match?.[1];
    if (name && retired.has(name)) continue;
    if (name && Object.hasOwn(replacements, name)) {
      output.push(`${name}=${safeValue(replacements[name])}`);
      seen.add(name);
    } else output.push(line);
  }
  for (const [name, value] of Object.entries(replacements)) {
    if (!seen.has(name)) output.push(`${name}=${safeValue(value)}`);
  }
  return `${output.join('\n').replace(/\n+$/, '')}\n`;
}

const source = readFileSync(environmentPath, 'utf8');
const values = parse(source.split(/\r?\n/));
const secretKey = values.STRIPE_SECRET_KEY?.trim();
const auditabilityMonthlyCents = values.AUDITABILITY_MONTHLY_CENTS?.trim();
if (!secretKey || !/^[sr]k_test_/.test(secretKey)) throw new Error('STRIPE_SECRET_KEY in .dev.vars must be a Stripe test or restricted test key');

const catalog = await ensureStripeCatalog(secretKey, { liveMode: false, auditabilityMonthlyCents });
const secrets = stripeWorkerSecrets(secretKey, catalog);
const replacement = { ...secrets };
delete replacement.STRIPE_SECRET_KEY;
const temporaryPath = `${environmentPath}.tmp-${process.pid}`;
writeFileSync(temporaryPath, updateEnvironment(source, replacement), { mode: 0o600 });
renameSync(temporaryPath, environmentPath);

console.log('Stripe test catalog is ready and local Worker bindings were updated.');
