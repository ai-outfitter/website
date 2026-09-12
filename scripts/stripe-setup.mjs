const STRIPE_API = 'https://api.stripe.com/v1';

export const stripeTiers = [
  {
    id: 'individual',
    name: 'AI Outfitter Individual',
    lookupKey: 'ai_outfitter_individual_monthly',
    unitAmount: 2_000,
  },
  {
    id: 'team',
    name: 'AI Outfitter Team',
    lookupKey: 'ai_outfitter_team_monthly',
    unitAmount: 20_000,
  },
];

function basicAuthorization(secretKey) {
  return `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`;
}

async function stripeRequest(secretKey, path, init = {}, stripeFetch = fetch) {
  const response = await stripeFetch(`${STRIPE_API}${path}`, {
    ...init,
    headers: {
      authorization: basicAuthorization(secretKey),
      ...init.headers,
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const requestId = response.headers.get('request-id');
    throw new Error(`Stripe request failed with HTTP ${response.status}${requestId ? ` (${requestId})` : ''}`);
  }
  return payload;
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function validateStripePrice(tier, value, liveMode) {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.startsWith('price_')) {
    throw new Error(`${tier.name} returned an invalid Stripe Price`);
  }
  const recurring = isRecord(value.recurring) ? value.recurring : {};
  const matches = value.active === true
    && value.currency === 'usd'
    && value.unit_amount === tier.unitAmount
    && value.type === 'recurring'
    && recurring.interval === 'month'
    && recurring.interval_count === 1
    && value.lookup_key === tier.lookupKey
    && value.livemode === liveMode;
  if (!matches) {
    throw new Error(`${tier.name} lookup key exists with pricing other than $${tier.unitAmount / 100}/month USD`);
  }
  return value.id;
}

async function existingPrice(secretKey, tier, liveMode, stripeFetch) {
  const query = new URLSearchParams({ limit: '2' });
  query.append('lookup_keys[]', tier.lookupKey);
  const result = await stripeRequest(secretKey, `/prices?${query}`, {}, stripeFetch);
  if (!isRecord(result) || !Array.isArray(result.data)) {
    throw new Error('Stripe returned an invalid Price list');
  }
  if (result.data.length > 1) {
    throw new Error(`${tier.name} lookup key resolved to more than one Price`);
  }
  if (result.data.length === 0) return null;
  if (result.data[0].active === false) {
    throw new Error(`${tier.name} lookup key belongs to an archived Stripe Price; restore it or transfer the lookup key before retrying`);
  }
  return validateStripePrice(tier, result.data[0], liveMode);
}

async function createPrice(secretKey, tier, liveMode, stripeFetch) {
  const body = new URLSearchParams({
    currency: 'usd',
    unit_amount: String(tier.unitAmount),
    'recurring[interval]': 'month',
    lookup_key: tier.lookupKey,
    'product_data[name]': tier.name,
    'metadata[ai_outfitter_tier]': tier.id,
  });
  const price = await stripeRequest(secretKey, '/prices', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': `ai-outfitter-${liveMode ? 'live' : 'test'}-${tier.lookupKey}-v1`,
    },
    body,
  }, stripeFetch);
  const priceId = validateStripePrice(tier, price, liveMode);
  const currentPrice = await stripeRequest(secretKey, `/prices/${encodeURIComponent(priceId)}`, {}, stripeFetch);
  return validateStripePrice(tier, currentPrice, liveMode);
}

export async function ensureStripePrices(secretKey, { liveMode, stripeFetch = fetch }) {
  const prices = {};
  for (const tier of stripeTiers) {
    prices[tier.id] = await existingPrice(secretKey, tier, liveMode, stripeFetch)
      ?? await createPrice(secretKey, tier, liveMode, stripeFetch);
  }
  return prices;
}

export function stripeWorkerSecrets(secretKey, prices) {
  return {
    STRIPE_SECRET_KEY: secretKey,
    STRIPE_INDIVIDUAL_PRICE_ID: prices.individual,
    STRIPE_TEAM_PRICE_ID: prices.team,
  };
}
