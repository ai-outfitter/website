import assert from 'node:assert/strict';

import { ensureStripePrices, stripeTiers, stripeWorkerSecrets, validateStripePrice } from './stripe-setup.mjs';

function price(tier, overrides = {}) {
  return {
    id: `price_${tier.id}`,
    active: true,
    currency: 'usd',
    unit_amount: tier.unitAmount,
    type: 'recurring',
    recurring: { interval: 'month', interval_count: 1 },
    lookup_key: tier.lookupKey,
    livemode: true,
    ...overrides,
  };
}

const existingRequests = [];
const existingFetch = async (url, init) => {
  existingRequests.push([url, init]);
  const tier = url.includes(stripeTiers[0].lookupKey) ? stripeTiers[0] : stripeTiers[1];
  return Response.json({ data: [price(tier)] }, { headers: { 'request-id': 'req_existing' } });
};
assert.deepEqual(
  await ensureStripePrices('sk_live_example', { liveMode: true, stripeFetch: existingFetch }),
  { individual: 'price_individual', team: 'price_team' },
);
assert.equal(existingRequests.length, 2);
assert(existingRequests.every(([, init]) => init?.method === undefined));
assert(existingRequests.every(([url]) => !new URL(url).searchParams.has('active')));

const archivedFetch = async (url) => {
  const tier = url.includes(stripeTiers[0].lookupKey) ? stripeTiers[0] : stripeTiers[1];
  return Response.json({ data: [price(tier, { active: false })] });
};
await assert.rejects(
  () => ensureStripePrices('sk_live_example', { liveMode: true, stripeFetch: archivedFetch }),
  /archived Stripe Price/,
);

const duplicateFetch = async (url) => {
  const tier = url.includes(stripeTiers[0].lookupKey) ? stripeTiers[0] : stripeTiers[1];
  return Response.json({ data: [price(tier), price(tier, { id: `price_${tier.id}_duplicate` })] });
};
await assert.rejects(
  () => ensureStripePrices('sk_live_example', { liveMode: true, stripeFetch: duplicateFetch }),
  /more than one Price/,
);

const createRequests = [];
let listCalls = 0;
const createFetch = async (url, init) => {
  createRequests.push([url, init]);
  if (url.includes('/prices?')) {
    listCalls += 1;
    return Response.json({ data: [] });
  }
  const body = init?.method === 'POST' ? new URLSearchParams(String(init.body)) : null;
  const tier = body
    ? stripeTiers.find((candidate) => candidate.lookupKey === body.get('lookup_key'))
    : stripeTiers.find((candidate) => url.endsWith(`price_${candidate.id}`));
  return Response.json(price(tier));
};
await ensureStripePrices('sk_live_example', { liveMode: true, stripeFetch: createFetch });
assert.equal(listCalls, 2);
const writes = createRequests.filter(([, init]) => init?.method === 'POST');
assert.equal(writes.length, 2);
assert.equal(createRequests.length, 6);
for (const [, init] of writes) {
  const body = new URLSearchParams(String(init.body));
  const tier = stripeTiers.find((candidate) => candidate.lookupKey === body.get('lookup_key'));
  assert(tier);
  assert.equal(body.get('currency'), 'usd');
  assert.equal(body.get('unit_amount'), String(tier.unitAmount));
  assert.equal(body.get('recurring[interval]'), 'month');
  assert.equal(body.get('product_data[name]'), tier.name);
  assert.match(init.headers['idempotency-key'], /^ai-outfitter-live-/);
}

assert.throws(
  () => validateStripePrice(stripeTiers[0], price(stripeTiers[0], { unit_amount: 2_001 }), true),
  /pricing other than \$20\/month USD/,
);
assert.throws(
  () => validateStripePrice(stripeTiers[0], price(stripeTiers[0], { livemode: false }), true),
  /pricing other than \$20\/month USD/,
);
assert.deepEqual(
  stripeWorkerSecrets('sk_live_example', { individual: 'price_one', team: 'price_two' }),
  {
    STRIPE_SECRET_KEY: 'sk_live_example',
    STRIPE_INDIVIDUAL_PRICE_ID: 'price_one',
    STRIPE_TEAM_PRICE_ID: 'price_two',
  },
);

console.log('Stripe setup planning regressions pass.');
