import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { auditabilityPrice, ensureStripeCatalog, noMarkupPromotion, stripeMeters, stripePrices, stripeWorkerSecrets } from './stripe-setup.mjs';

const AUDITABILITY_MONTHLY_CENTS = '10000';
const allStripePrices = [...stripePrices, auditabilityPrice(AUDITABILITY_MONTHLY_CENTS)];

function makeStripeMock() {
  const state = { meters: [], prices: [], products: [], coupon: null, promotionCode: null, requests: [] };

  function meterFromBody(body) {
    return {
      id: `mtr_${body.get('event_name')}`,
      display_name: body.get('display_name'),
      event_name: body.get('event_name'),
      status: 'active',
      livemode: true,
      customer_mapping: { type: body.get('customer_mapping[type]'), event_payload_key: body.get('customer_mapping[event_payload_key]') },
      default_aggregation: { formula: body.get('default_aggregation[formula]') },
      value_settings: { event_payload_key: body.get('value_settings[event_payload_key]') },
    };
  }

  function priceFromBody(body) {
    const spec = allStripePrices.find(({ lookupKey }) => lookupKey === body.get('lookup_key'));
    assert(spec);
    const product = {
      id: `prod_${spec.id}`,
      active: true,
      name: body.get('product_data[name]'),
      livemode: true,
      metadata: { ai_outfitter_component: body.get('product_data[metadata][ai_outfitter_component]') },
    };
    state.products.push(product);
    return {
      id: `price_${spec.id}`,
      active: true,
      currency: body.get('currency'),
      unit_amount: spec.id === 'resident' ? 2_000 : null,
      unit_amount_decimal: body.get('unit_amount_decimal'),
      type: 'recurring',
      recurring: {
        interval: body.get('recurring[interval]'),
        interval_count: 1,
        usage_type: body.get('recurring[usage_type]'),
        meter: body.get('recurring[meter]'),
      },
      lookup_key: spec.lookupKey,
      product: product.id,
      livemode: true,
    };
  }

  const stripeFetch = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    const method = init.method ?? 'GET';
    const body = method === 'POST' ? new URLSearchParams(String(init.body)) : null;
    state.requests.push({ url, method, body, headers: init.headers });

    if (url.pathname === '/v1/billing/meters' && method === 'GET') return Response.json({ data: state.meters, has_more: false });
    if (url.pathname === '/v1/billing/meters' && method === 'POST') {
      const meter = meterFromBody(body);
      state.meters.push(meter);
      return Response.json(meter);
    }
    if (url.pathname === '/v1/prices' && method === 'GET') {
      const lookupKey = url.searchParams.get('lookup_keys[]');
      return Response.json({ data: state.prices.filter((price) => price.lookup_key === lookupKey) });
    }
    if (url.pathname === '/v1/prices' && method === 'POST') {
      const price = priceFromBody(body);
      state.prices.push(price);
      return Response.json(price);
    }
    if (url.pathname.startsWith('/v1/products/') && method === 'GET') {
      const id = decodeURIComponent(url.pathname.slice('/v1/products/'.length));
      return Response.json(state.products.find((product) => product.id === id));
    }
    if (url.pathname === `/v1/coupons/${noMarkupPromotion.couponId}` && method === 'GET') {
      return state.coupon ? Response.json(state.coupon) : Response.json({ error: {} }, { status: 404 });
    }
    if (url.pathname === '/v1/coupons' && method === 'POST') {
      state.coupon = {
        id: body.get('id'),
        valid: true,
        percent_off: Number(body.get('percent_off')),
        duration: body.get('duration'),
        livemode: true,
        applies_to: { products: body.getAll('applies_to[products][]') },
      };
      return Response.json(state.coupon);
    }
    if (url.pathname === '/v1/promotion_codes' && method === 'GET') {
      const matches = state.promotionCode?.code.toUpperCase() === url.searchParams.get('code')?.toUpperCase() ? [state.promotionCode] : [];
      return Response.json({ data: matches });
    }
    if (url.pathname === '/v1/promotion_codes' && method === 'POST') {
      state.promotionCode = {
        id: 'promo_no_markup',
        active: true,
        code: body.get('code'),
        customer: null,
        max_redemptions: Number(body.get('max_redemptions')),
        restrictions: { first_time_transaction: body.get('restrictions[first_time_transaction]') === 'true' },
        livemode: true,
        promotion: { type: body.get('promotion[type]'), coupon: body.get('promotion[coupon]') },
      };
      return Response.json(state.promotionCode);
    }
    throw new Error(`Unhandled mock Stripe request: ${method} ${url.pathname}`);
  };

  return { state, stripeFetch };
}

const mock = makeStripeMock();
const first = await ensureStripeCatalog('sk_live_example', { liveMode: true, auditabilityMonthlyCents: AUDITABILITY_MONTHLY_CENTS, stripeFetch: mock.stripeFetch });
const second = await ensureStripeCatalog('sk_live_example', { liveMode: true, auditabilityMonthlyCents: AUDITABILITY_MONTHLY_CENTS, stripeFetch: mock.stripeFetch });
assert.deepEqual(second, first, 'rerunning catalog setup must return the same object IDs');

const writes = mock.state.requests.filter(({ method }) => method === 'POST');
assert.equal(writes.length, 8, 'rerunning setup must not create duplicate objects');
assert.equal(writes.filter(({ url }) => url.pathname === '/v1/billing/meters').length, 2);
assert.equal(writes.filter(({ url }) => url.pathname === '/v1/prices').length, 4);
assert.equal(writes.filter(({ url }) => url.pathname === '/v1/coupons').length, 1);
assert.equal(writes.filter(({ url }) => url.pathname === '/v1/promotion_codes').length, 1);
assert(writes.every(({ headers }) => headers['idempotency-key']?.startsWith('ai-outfitter-live-')));

for (const spec of allStripePrices) {
  const request = writes.find(({ url, body }) => url.pathname === '/v1/prices' && body.get('lookup_key') === spec.lookupKey);
  assert(request);
  assert.equal(request.body.get('unit_amount_decimal'), spec.unitAmountDecimal);
  assert.equal(request.body.get('recurring[interval]'), 'month');
  assert.equal(request.body.get('recurring[usage_type]'), spec.usageType);
  assert.equal(request.body.get('product_data[name]'), spec.name);
  if (spec.usageType === 'metered') assert.equal(request.body.get('recurring[meter]'), first.meters[spec.meterId].id);
  else assert.equal(request.body.get('recurring[meter]'), null);
}

const couponWrite = writes.find(({ url }) => url.pathname === '/v1/coupons');
assert.deepEqual(couponWrite.body.getAll('applies_to[products][]'), [first.prices.markup.productId]);
assert.notEqual(first.prices.markup.productId, first.prices.resident.productId);
assert.notEqual(first.prices.markup.productId, first.prices.providerCost.productId);
assert.notEqual(first.prices.markup.productId, first.prices.auditability.productId);
assert.equal(couponWrite.body.get('percent_off'), '100');
assert.equal(couponWrite.body.get('duration'), 'forever');

const promotionWrite = writes.find(({ url }) => url.pathname === '/v1/promotion_codes');
assert.equal(promotionWrite.body.get('code'), 'NO-MARKUP');
assert.equal(promotionWrite.body.get('promotion[type]'), 'coupon');
assert.equal(promotionWrite.body.get('promotion[coupon]'), first.couponId);
assert.equal(promotionWrite.body.get('max_redemptions'), '1');
assert.equal(promotionWrite.body.get('restrictions[first_time_transaction]'), 'true');
assert.equal(promotionWrite.body.get('customer'), null, 'promotion must not encode a customer identity');

assert.deepEqual(stripeWorkerSecrets('sk_live_example', first), {
  STRIPE_SECRET_KEY: 'sk_live_example',
  STRIPE_RESIDENT_PRICE_ID: 'price_resident',
  STRIPE_PROVIDER_COST_PRICE_ID: 'price_providerCost',
  STRIPE_MARKUP_PRICE_ID: 'price_markup',
  STRIPE_AUDITABILITY_PRICE_ID: 'price_auditability',
  STRIPE_PROVIDER_COST_METER_EVENT_NAME: stripeMeters[0].eventName,
  STRIPE_MARKUP_METER_EVENT_NAME: stripeMeters[1].eventName,
  STRIPE_NO_MARKUP_COUPON_ID: noMarkupPromotion.couponId,
  STRIPE_NO_MARKUP_PROMOTION_CODE_ID: 'promo_no_markup',
});

const priceMismatch = makeStripeMock();
await ensureStripeCatalog('sk_live_example', { liveMode: true, auditabilityMonthlyCents: AUDITABILITY_MONTHLY_CENTS, stripeFetch: priceMismatch.stripeFetch });
priceMismatch.state.prices[0].unit_amount_decimal = '2001';
await assert.rejects(
  () => ensureStripeCatalog('sk_live_example', { liveMode: true, auditabilityMonthlyCents: AUDITABILITY_MONTHLY_CENTS, stripeFetch: priceMismatch.stripeFetch }),
  /different price definition/,
  'an existing lookup key with changed terms must be rejected',
);

const couponMismatch = makeStripeMock();
await ensureStripeCatalog('sk_live_example', { liveMode: true, auditabilityMonthlyCents: AUDITABILITY_MONTHLY_CENTS, stripeFetch: couponMismatch.stripeFetch });
couponMismatch.state.coupon.applies_to.products = ['prod_providerCost'];
await assert.rejects(
  () => ensureStripeCatalog('sk_live_example', { liveMode: true, auditabilityMonthlyCents: AUDITABILITY_MONTHLY_CENTS, stripeFetch: couponMismatch.stripeFetch }),
  /different coupon definition/,
  'a coupon that could discount provider cost instead of markup must be rejected',
);

const promotionMismatch = makeStripeMock();
await ensureStripeCatalog('sk_live_example', { liveMode: true, auditabilityMonthlyCents: AUDITABILITY_MONTHLY_CENTS, stripeFetch: promotionMismatch.stripeFetch });
promotionMismatch.state.promotionCode.max_redemptions = null;
await assert.rejects(
  () => ensureStripeCatalog('sk_live_example', { liveMode: true, auditabilityMonthlyCents: AUDITABILITY_MONTHLY_CENTS, stripeFetch: promotionMismatch.stripeFetch }),
  /different promotion-code definition/,
  'a reusable first-customer code without a one-redemption limit must be rejected',
);
promotionMismatch.state.promotionCode.max_redemptions = 1;
promotionMismatch.state.promotionCode.restrictions.first_time_transaction = false;
await assert.rejects(
  () => ensureStripeCatalog('sk_live_example', { liveMode: true, auditabilityMonthlyCents: AUDITABILITY_MONTHLY_CENTS, stripeFetch: promotionMismatch.stripeFetch }),
  /different promotion-code definition/,
  'a reusable first-customer code without the first-transaction restriction must be rejected',
);

const guarded = spawnSync(process.execPath, ['scripts/configure-stripe.mjs'], { encoding: 'utf8' });
assert.notEqual(guarded.status, 0);
assert.match(guarded.stderr, /explicit --live flag/);

console.log('Stripe resident catalog regressions pass.');
