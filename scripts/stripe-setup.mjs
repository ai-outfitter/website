const STRIPE_API = 'https://api.stripe.com/v1';
const STRIPE_API_VERSION = '2025-03-31.basil';
const MICRODOLLAR_IN_CENTS = '0.0001';

export const stripeMeters = [
  { id: 'providerCost', displayName: 'AI Outfitter Provider Cost Microdollars', eventName: 'ai_outfitter_provider_cost_microdollars' },
  { id: 'markup', displayName: 'AI Outfitter Markup Microdollars', eventName: 'ai_outfitter_markup_microdollars' },
];

export const stripePrices = [
  { id: 'resident', name: 'AI Outfitter Resident', lookupKey: 'ai_outfitter_resident_monthly_v1', unitAmountDecimal: '2000', usageType: 'licensed' },
  { id: 'providerCost', name: 'AI Outfitter Provider Cost', lookupKey: 'ai_outfitter_provider_cost_microdollars_monthly_v1', unitAmountDecimal: MICRODOLLAR_IN_CENTS, usageType: 'metered', meterId: 'providerCost' },
  { id: 'markup', name: 'AI Outfitter Markup', lookupKey: 'ai_outfitter_markup_microdollars_monthly_v1', unitAmountDecimal: MICRODOLLAR_IN_CENTS, usageType: 'metered', meterId: 'markup' },
];

export function auditabilityPrice(monthlyCents) {
  const normalized = String(monthlyCents ?? '').trim();
  if (!/^\d+$/.test(normalized) || Number(normalized) < 1 || !Number.isSafeInteger(Number(normalized))) {
    throw new Error('AUDITABILITY_MONTHLY_CENTS must be a positive integer chosen by the product owner');
  }
  return {
    id: 'auditability',
    name: 'AI Outfitter Enterprise Auditability',
    lookupKey: `ai_outfitter_enterprise_auditability_${normalized}_cents_monthly_v1`,
    unitAmountDecimal: normalized,
    usageType: 'licensed',
  };
}

export const noMarkupPromotion = {
  // v1 predated split provider-cost/markup Products and could discount the
  // customer's pass-through inference charges. Never reuse that coupon.
  couponId: 'ai_outfitter_no_markup_forever_v2',
  couponName: 'AI Outfitter No Markup',
  code: 'NO-MARKUP',
};

function basicAuthorization(secretKey) {
  return `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`;
}

async function stripeRequest(secretKey, path, init = {}, stripeFetch = fetch, { allowNotFound = false } = {}) {
  const response = await stripeFetch(`${STRIPE_API}${path}`, {
    ...init,
    headers: { authorization: basicAuthorization(secretKey), 'stripe-version': STRIPE_API_VERSION, ...init.headers },
  });
  const payload = await response.json().catch(() => null);
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    const requestId = response.headers.get('request-id');
    const detail = typeof payload?.error?.message === 'string'
      ? `: ${payload.error.message.replace(/[\r\n]/g, ' ')}`
      : '';
    throw new Error(`Stripe request failed with HTTP ${response.status}${requestId ? ` (${requestId})` : ''}${detail}`);
  }
  return payload;
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function idWithPrefix(value, prefix) {
  return typeof value === 'string' && value.startsWith(prefix);
}

function mismatch(name, detail) {
  throw new Error(`${name} exists with a different ${detail}; refusing to reuse it`);
}

export function validateStripeMeter(spec, value, liveMode) {
  if (!isRecord(value) || !idWithPrefix(value.id, 'mtr_')) throw new Error(`${spec.displayName} returned an invalid Stripe Meter`);
  const customerMapping = isRecord(value.customer_mapping) ? value.customer_mapping : {};
  const aggregation = isRecord(value.default_aggregation) ? value.default_aggregation : {};
  const valueSettings = isRecord(value.value_settings) ? value.value_settings : {};
  if (value.display_name !== spec.displayName
    || value.event_name !== spec.eventName
    || value.status !== 'active'
    || value.livemode !== liveMode
    || customerMapping.type !== 'by_id'
    || customerMapping.event_payload_key !== 'stripe_customer_id'
    || aggregation.formula !== 'sum'
    || valueSettings.event_payload_key !== 'value') mismatch(spec.displayName, 'meter definition');
  return value.id;
}

async function listAllMeters(secretKey, stripeFetch) {
  const meters = [];
  let startingAfter;
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (startingAfter) query.set('starting_after', startingAfter);
    const result = await stripeRequest(secretKey, `/billing/meters?${query}`, {}, stripeFetch);
    if (!isRecord(result) || !Array.isArray(result.data)) throw new Error('Stripe returned an invalid Meter list');
    meters.push(...result.data);
    if (result.has_more === true) {
      const last = result.data.at(-1);
      if (!isRecord(last) || !idWithPrefix(last.id, 'mtr_')) throw new Error('Stripe returned an invalid paginated Meter list');
      startingAfter = last.id;
    } else startingAfter = undefined;
  } while (startingAfter);
  return meters;
}

async function ensureMeters(secretKey, liveMode, stripeFetch) {
  const listed = await listAllMeters(secretKey, stripeFetch);
  const meters = {};
  for (const spec of stripeMeters) {
    const matches = listed.filter((candidate) => candidate?.event_name === spec.eventName);
    if (matches.length > 1) throw new Error(`${spec.displayName} event name resolved to more than one Meter`);
    let meter = matches[0];
    if (!meter) {
      const body = new URLSearchParams({
        display_name: spec.displayName,
        event_name: spec.eventName,
        'default_aggregation[formula]': 'sum',
        'customer_mapping[type]': 'by_id',
        'customer_mapping[event_payload_key]': 'stripe_customer_id',
        'value_settings[event_payload_key]': 'value',
      });
      meter = await stripeRequest(secretKey, '/billing/meters', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `ai-outfitter-${liveMode ? 'live' : 'test'}-${spec.eventName}-v1` },
        body,
      }, stripeFetch);
    }
    meters[spec.id] = { id: validateStripeMeter(spec, meter, liveMode), eventName: spec.eventName };
  }
  return meters;
}

export function validateStripePrice(spec, value, liveMode, meterId = null) {
  if (!isRecord(value) || !idWithPrefix(value.id, 'price_')) throw new Error(`${spec.name} returned an invalid Stripe Price`);
  const recurring = isRecord(value.recurring) ? value.recurring : {};
  const productId = isRecord(value.product) ? value.product.id : value.product;
  const expectedMeter = spec.usageType === 'metered' ? meterId : null;
  if (value.active !== true
    || value.currency !== 'usd'
    || String(value.unit_amount_decimal) !== spec.unitAmountDecimal
    || value.type !== 'recurring'
    || recurring.interval !== 'month'
    || recurring.interval_count !== 1
    || recurring.usage_type !== spec.usageType
    || (recurring.meter ?? null) !== expectedMeter
    || value.lookup_key !== spec.lookupKey
    || value.livemode !== liveMode
    || !idWithPrefix(productId, 'prod_')) mismatch(spec.name, 'price definition');
  return { priceId: value.id, productId };
}

function validateStripeProduct(spec, value, liveMode, expectedProductId) {
  if (!isRecord(value) || value.id !== expectedProductId || !idWithPrefix(value.id, 'prod_')) throw new Error(`${spec.name} returned an invalid Stripe Product`);
  if (value.active !== true
    || value.name !== spec.name
    || value.livemode !== liveMode
    || value.metadata?.ai_outfitter_component !== spec.id) mismatch(spec.name, 'product definition');
}

async function existingPrice(secretKey, spec, liveMode, meterId, stripeFetch) {
  const query = new URLSearchParams({ limit: '2' });
  query.append('lookup_keys[]', spec.lookupKey);
  const result = await stripeRequest(secretKey, `/prices?${query}`, {}, stripeFetch);
  if (!isRecord(result) || !Array.isArray(result.data)) throw new Error('Stripe returned an invalid Price list');
  if (result.data.length > 1) throw new Error(`${spec.name} lookup key resolved to more than one Price`);
  if (result.data.length === 0) return null;
  return validateStripePrice(spec, result.data[0], liveMode, meterId);
}

async function createPrice(secretKey, spec, liveMode, meterId, stripeFetch) {
  const body = new URLSearchParams({
    currency: 'usd',
    unit_amount_decimal: spec.unitAmountDecimal,
    'recurring[interval]': 'month',
    'recurring[usage_type]': spec.usageType,
    lookup_key: spec.lookupKey,
    'product_data[name]': spec.name,
    'product_data[metadata][ai_outfitter_component]': spec.id,
    'metadata[ai_outfitter_component]': spec.id,
  });
  if (meterId) body.set('recurring[meter]', meterId);
  const price = await stripeRequest(secretKey, '/prices', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `ai-outfitter-${liveMode ? 'live' : 'test'}-${spec.lookupKey}-v1` },
    body,
  }, stripeFetch);
  return validateStripePrice(spec, price, liveMode, meterId);
}

async function ensurePrices(secretKey, liveMode, meters, priceSpecs, stripeFetch) {
  const prices = {};
  for (const spec of priceSpecs) {
    const meterId = spec.meterId ? meters[spec.meterId].id : null;
    const found = await existingPrice(secretKey, spec, liveMode, meterId, stripeFetch)
      ?? await createPrice(secretKey, spec, liveMode, meterId, stripeFetch);
    const product = await stripeRequest(secretKey, `/products/${encodeURIComponent(found.productId)}`, {}, stripeFetch);
    validateStripeProduct(spec, product, liveMode, found.productId);
    prices[spec.id] = found;
  }
  if (new Set(Object.values(prices).map(({ productId }) => productId)).size !== priceSpecs.length) {
    throw new Error('Resident, provider-cost, markup, and auditability Prices must belong to separate Stripe Products');
  }
  return prices;
}

export function validateNoMarkupCoupon(value, markupProductId, liveMode) {
  if (!isRecord(value) || value.id !== noMarkupPromotion.couponId) throw new Error('No-markup coupon returned an invalid Stripe Coupon');
  const products = value.applies_to?.products;
  if (value.valid !== true
    || value.percent_off !== 100
    || value.duration !== 'forever'
    || value.livemode !== liveMode
    || !Array.isArray(products)
    || products.length !== 1
    || products[0] !== markupProductId) mismatch(noMarkupPromotion.couponName,
      `coupon definition (${JSON.stringify({ valid: value.valid, percentOff: value.percent_off, duration: value.duration,
        liveMode: value.livemode, products })})`);
  return value.id;
}

async function ensureCoupon(secretKey, markupProductId, liveMode, stripeFetch) {
  let coupon = await stripeRequest(secretKey,
    `/coupons/${encodeURIComponent(noMarkupPromotion.couponId)}?expand[]=applies_to`, {}, stripeFetch, { allowNotFound: true });
  if (!coupon) {
    const body = new URLSearchParams({
      id: noMarkupPromotion.couponId,
      name: noMarkupPromotion.couponName,
      percent_off: '100',
      duration: 'forever',
      'applies_to[products][]': markupProductId,
      'metadata[ai_outfitter_component]': 'markup',
    });
    body.append('expand[]', 'applies_to');
    coupon = await stripeRequest(secretKey, '/coupons', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `ai-outfitter-${liveMode ? 'live' : 'test'}-no-markup-coupon-v2` },
      body,
    }, stripeFetch);
  }
  return validateNoMarkupCoupon(coupon, markupProductId, liveMode);
}

function promotionCouponId(value) {
  if (isRecord(value?.promotion) && value.promotion.type === 'coupon') return value.promotion.coupon;
  return isRecord(value?.coupon) ? value.coupon.id : value?.coupon;
}

export function validateNoMarkupPromotionCode(value, couponId, liveMode) {
  if (!isRecord(value) || !idWithPrefix(value.id, 'promo_')) throw new Error('No-markup promotion returned an invalid Stripe Promotion Code');
  if (value.active !== true
    || value.code?.toUpperCase() !== noMarkupPromotion.code
    || value.customer != null
    || value.max_redemptions !== 1
    || value.restrictions?.first_time_transaction !== true
    || value.livemode !== liveMode
    || promotionCouponId(value) !== couponId) mismatch(noMarkupPromotion.code, 'promotion-code definition');
  return value.id;
}

async function ensurePromotionCode(secretKey, couponId, liveMode, stripeFetch) {
  const query = new URLSearchParams({ code: noMarkupPromotion.code, limit: '2' });
  const result = await stripeRequest(secretKey, `/promotion_codes?${query}`, {}, stripeFetch);
  if (!isRecord(result) || !Array.isArray(result.data)) throw new Error('Stripe returned an invalid Promotion Code list');
  if (result.data.length > 1) throw new Error(`${noMarkupPromotion.code} resolved to more than one Promotion Code`);
  let promotionCode = result.data[0];
  if (!promotionCode) {
    const body = new URLSearchParams({
      code: noMarkupPromotion.code,
      max_redemptions: '1',
      'restrictions[first_time_transaction]': 'true',
      'promotion[type]': 'coupon',
      'promotion[coupon]': couponId,
      'metadata[ai_outfitter_component]': 'markup',
    });
    promotionCode = await stripeRequest(secretKey, '/promotion_codes', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `ai-outfitter-${liveMode ? 'live' : 'test'}-no-markup-promotion-v1` },
      body,
    }, stripeFetch);
  }
  return validateNoMarkupPromotionCode(promotionCode, couponId, liveMode);
}

export async function ensureStripeCatalog(secretKey, { liveMode, auditabilityMonthlyCents, stripeFetch = fetch }) {
  const meters = await ensureMeters(secretKey, liveMode, stripeFetch);
  const prices = await ensurePrices(secretKey, liveMode, meters,
    [...stripePrices, auditabilityPrice(auditabilityMonthlyCents)], stripeFetch);
  const couponId = await ensureCoupon(secretKey, prices.markup.productId, liveMode, stripeFetch);
  const promotionCodeId = await ensurePromotionCode(secretKey, couponId, liveMode, stripeFetch);
  return { meters, prices, couponId, promotionCodeId, promotionCode: noMarkupPromotion.code };
}

export function stripeWorkerSecrets(secretKey, catalog) {
  return {
    STRIPE_SECRET_KEY: secretKey,
    STRIPE_RESIDENT_PRICE_ID: catalog.prices.resident.priceId,
    STRIPE_PROVIDER_COST_PRICE_ID: catalog.prices.providerCost.priceId,
    STRIPE_MARKUP_PRICE_ID: catalog.prices.markup.priceId,
    STRIPE_AUDITABILITY_PRICE_ID: catalog.prices.auditability.priceId,
    STRIPE_PROVIDER_COST_METER_EVENT_NAME: catalog.meters.providerCost.eventName,
    STRIPE_MARKUP_METER_EVENT_NAME: catalog.meters.markup.eventName,
    STRIPE_NO_MARKUP_COUPON_ID: catalog.couponId,
    STRIPE_NO_MARKUP_PROMOTION_CODE_ID: catalog.promotionCodeId,
  };
}
