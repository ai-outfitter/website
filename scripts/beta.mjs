import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let owner = root;
while (!existsSync(resolve(owner, 'outfitter/README.md'))) {
  if (dirname(owner) === owner) throw new Error('Owner environment not found');
  owner = dirname(owner);
}
const values = {};
for (const line of readFileSync(resolve(owner, '.env'), 'utf8').split(/\r?\n/)) {
  const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (match) values[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, '$2');
}
const source = { ...values, ...process.env };
if (!source.CLOUDFLARE_API_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN required');
const mode = process.argv[2];
if (!['configure', 'deploy'].includes(mode)) throw new Error('Use beta.mjs configure|deploy');
const environment = { ...process.env, CLOUDFLARE_API_TOKEN: source.CLOUDFLARE_API_TOKEN };
function run(args, input) {
  const result = spawnSync('npm', ['exec', '--', 'wrangler', ...args, '--env', 'beta'], { cwd: root, env: environment, input, stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (mode === 'deploy') {
  run(['deploy']);
} else {
  if (!source.GH_TOKEN_RO) throw new Error('GH_TOKEN_RO required');
  const path = resolve(root, '.beta-secrets.json');
  const secrets = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  secrets.BETA_ACCESS_PASSWORD ||= randomBytes(32).toString('base64url');
  secrets.AGENTS_PLAN_SIGNING_KEY ||= randomBytes(32).toString('hex');
  secrets.BETA_GITHUB_TOKEN = source.GH_TOKEN_RO;
  if (source.STRIPE_TEST_SECRET_KEY) {
    if (!/^(sk|rk)_test_/.test(source.STRIPE_TEST_SECRET_KEY)) throw new Error('A sandbox Stripe key is required');
    if (secrets.STRIPE_SECRET_KEY && secrets.STRIPE_SECRET_KEY !== source.STRIPE_TEST_SECRET_KEY) throw new Error('Changing Stripe keys requires explicit sandbox account and webhook reconciliation');
    secrets.STRIPE_SECRET_KEY = source.STRIPE_TEST_SECRET_KEY;
    if (!secrets.STRIPE_WEBHOOK_SECRET) {
      const response = await fetch('https://api.stripe.com/v1/webhook_endpoints', {
        method: 'POST', headers: { authorization: `Bearer ${secrets.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': 'outfitter-beta-prepaid-webhook-v1' },
        body: new URLSearchParams([
          ['url', 'https://beta.ai-outfitter.com/api/webhooks/stripe'],
          ...['payment_intent.succeeded', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed'].map(event => ['enabled_events[]', event]),
        ]),
      });
      if (!response.ok) throw new Error(`Stripe webhook setup failed (HTTP ${response.status})`);
      const webhook = await response.json();
      if (webhook.livemode || !webhook.secret?.startsWith('whsec_')) throw new Error('Invalid sandbox webhook response');
      secrets.STRIPE_WEBHOOK_SECRET = webhook.secret;
    }
  }
  writeFileSync(path, JSON.stringify(secrets), { mode: 0o600 });
  chmodSync(path, 0o600);
  run(['secret', 'bulk'], JSON.stringify(secrets));
  console.log('Beta credentials saved in ignored .beta-secrets.json (username: beta). No production secrets changed.');
  console.log(secrets.STRIPE_WEBHOOK_SECRET ? 'Sandbox Stripe configured.' : 'Sandbox Stripe still needs STRIPE_TEST_SECRET_KEY in the owner .env.');
}
