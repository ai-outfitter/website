import type {
  BillingAccount, BillingReviewEvent, BillingStore, SubscriptionLifecycleEvent, SubscriptionStatus,
} from "./billing-store";
import { parseStripeEvent, verifyStripeWebhookSignature, type StripeEvent } from "./stripe-webhook";

const STRIPE_API = "https://api.stripe.com/v1";
const STRIPE_API_VERSION = "2025-03-31.basil";
const MAX_WEBHOOK_BYTES = 1_000_000;
const SUPPORTED_STATUSES = new Set<SubscriptionStatus>([
  "incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused",
]);
const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);
const CHECKOUT_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
]);
const INVOICE_EVENTS = new Set([
  "invoice.paid", "invoice.payment_failed", "invoice.payment_action_required",
  "invoice.finalization_failed", "invoice.voided", "invoice.marked_uncollectible",
]);
const BILLING_REVIEW_EVENTS = new Set([
  "charge.dispute.created", "charge.refunded", "refund.created", "refund.updated",
]);

type StripeRecord = Record<string, unknown>;
type WebhookStore = Pick<BillingStore,
  "getBillingAccountByStripeCustomer" | "getAccountStatus" | "applySubscriptionEvent" | "applyBillingReviewEvent">;

type WebhookOptions = {
  store: WebhookStore;
  stripeFetch?: typeof fetch;
  dispatchProvisioning?: (account: BillingAccount) => Promise<void>;
  now?: number;
};

function json(value: unknown, status: number) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function record(value: unknown): value is StripeRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function id(value: unknown, prefix: string) {
  const candidate = record(value) ? value.id : value;
  return typeof candidate === "string" && candidate.startsWith(prefix) ? candidate : null;
}

function objectId(value: unknown) {
  const candidate = record(value) ? value.id : value;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function integer(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function metadata(value: StripeRecord) {
  return record(value.metadata) ? value.metadata : {};
}

function basicAuthorization(secret: string) {
  return `Basic ${btoa(`${secret}:`)}`;
}

async function stripeGet(path: string, secret: string, query: URLSearchParams, stripeFetch: typeof fetch) {
  const response = await stripeFetch(`${STRIPE_API}${path}?${query}`, {
    headers: { authorization: basicAuthorization(secret), "stripe-version": STRIPE_API_VERSION },
  });
  const requestId = response.headers.get("request-id");
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok || !record(value)) {
    console.error(JSON.stringify({ message: "Stripe reconciliation request failed", status: response.status, stripeRequestId: requestId }));
    throw new Error("Stripe reconciliation failed");
  }
  return value;
}

function eventSubscriptionId(event: StripeEvent) {
  const object = event.data.object;
  if (CHECKOUT_EVENTS.has(event.type)) return id(object.subscription, "sub_");
  if (SUBSCRIPTION_EVENTS.has(event.type)) return id(object, "sub_");
  if (INVOICE_EVENTS.has(event.type)) {
    const parent = record(object.parent) ? object.parent : null;
    const details = parent && record(parent.subscription_details) ? parent.subscription_details : null;
    return id(details?.subscription ?? object.subscription, "sub_");
  }
  return null;
}

function invoiceSubscriptionId(invoice: StripeRecord) {
  const parent = record(invoice.parent) ? invoice.parent : null;
  const details = parent && record(parent.subscription_details) ? parent.subscription_details : null;
  return id(details?.subscription ?? invoice.subscription, "sub_");
}

function configured(env: Env) {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
  const residentPrice = env.STRIPE_RESIDENT_PRICE_ID?.trim();
  const providerCostPrice = env.STRIPE_PROVIDER_COST_PRICE_ID?.trim();
  const markupPrice = env.STRIPE_MARKUP_PRICE_ID?.trim();
  const auditabilityPrice = env.STRIPE_AUDITABILITY_PRICE_ID?.trim();
  const coupon = env.STRIPE_NO_MARKUP_COUPON_ID?.trim();
  const promotionCode = env.STRIPE_NO_MARKUP_PROMOTION_CODE_ID?.trim();
  const residentAgentNameOverrides = env.RESIDENT_AGENT_NAME_OVERRIDES?.trim();
  return secretKey && webhookSecret && residentPrice && providerCostPrice && markupPrice && coupon && promotionCode
    ? { secretKey, webhookSecret, residentPrice, providerCostPrice, markupPrice, auditabilityPrice, coupon, promotionCode,
      residentAgentNameOverrides }
    : null;
}

function itemPriceId(item: StripeRecord) {
  return id(item.price, "price_");
}

function subscriptionPeriod(subscription: StripeRecord, residentItem: StripeRecord) {
  const start = integer(subscription.current_period_start) ?? integer(residentItem.current_period_start);
  const end = integer(subscription.current_period_end) ?? integer(residentItem.current_period_end);
  if (start === null || end === null || end < start) throw new Error("Stripe subscription has an invalid billing period");
  return { start, end };
}

function discountEvidence(value: unknown) {
  const promotions = new Set<string>();
  const coupons = new Set<string>();
  if (!Array.isArray(value)) return { promotions, coupons };
  for (const discount of value) {
    if (!record(discount)) continue;
    const direct = id(discount.promotion_code, "promo_");
    const source = record(discount.source) ? discount.source : null;
    const coupon = source?.type === "coupon" ? objectId(source.coupon) : objectId(discount.coupon);
    if (direct) promotions.add(direct);
    if (coupon) coupons.add(coupon);
  }
  return { promotions, coupons };
}

function validateDiscount(subscription: StripeRecord, checkout: StripeRecord | null, promotionCode: string, couponId: string) {
  const meta = metadata(subscription);
  const expected = meta.markup_promotion === "no-markup";
  const subscriptionEvidence = discountEvidence(subscription.discounts);
  const checkoutEvidence = discountEvidence(checkout?.discounts);
  const promotionIds = new Set([...subscriptionEvidence.promotions, ...checkoutEvidence.promotions]);
  const couponIds = new Set([...subscriptionEvidence.coupons, ...checkoutEvidence.coupons]);
  const discountCount = Math.max(
    Array.isArray(subscription.discounts) ? subscription.discounts.length : 0,
    Array.isArray(checkout?.discounts) ? checkout.discounts.length : 0,
  );
  if (expected && (discountCount !== 1 || promotionIds.size !== 1 || couponIds.size !== 1
    || !promotionIds.has(promotionCode) || !couponIds.has(couponId))) {
    throw new Error("Stripe subscription is missing the configured no-markup promotion");
  }
  if (!expected && discountCount !== 0) {
    throw new Error("Stripe subscription contains an unauthorized discount");
  }
}

function deterministicAgentName(account: BillingAccount) {
  const login = account.githubAccountLogin.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 38) || "github";
  const suffix = account.githubAccountId.replace(/[^0-9]/g, "").slice(-10) || "account";
  return `${login}-luce-${suffix}`.slice(0, 63).replace(/-+$/g, "");
}

function residentAgentName(account: BillingAccount, overridesJson: string | undefined) {
  const configured = overridesJson?.trim();
  if (!configured) return deterministicAgentName(account);
  let parsed: unknown;
  try { parsed = JSON.parse(configured); }
  catch { throw new Error("Resident Agent name overrides are invalid"); }
  if (!record(parsed)) throw new Error("Resident Agent name overrides are invalid");
  const override = parsed[account.githubAccountId];
  if (override === undefined) return deterministicAgentName(account);
  if (typeof override !== "string" || override.length > 63
    || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(override)) {
    throw new Error("Configured resident Agent name is invalid");
  }
  return override;
}

function lifecycleEvent(
  event: StripeEvent,
  rawBody: string,
  subscription: StripeRecord,
  checkout: StripeRecord | null,
  account: BillingAccount,
  config: NonNullable<ReturnType<typeof configured>>,
  now: number,
): SubscriptionLifecycleEvent {
  const subscriptionId = id(subscription, "sub_");
  const customerId = id(subscription.customer, "cus_");
  const status = typeof subscription.status === "string" && SUPPORTED_STATUSES.has(subscription.status as SubscriptionStatus)
    ? subscription.status as SubscriptionStatus : null;
  const data = record(subscription.items) && Array.isArray(subscription.items.data) ? subscription.items.data.filter(record) : [];
  const meta = metadata(subscription);
  const auditabilityEnabled = meta.auditability === "enterprise";
  const pensieveProfile = typeof meta.pensieve_profile === "string" ? meta.pensieve_profile : null;
  if (auditabilityEnabled && (!config.auditabilityPrice || pensieveProfile !== "resident-complete-trace-v1")) {
    throw new Error("Stripe subscription requests an unsupported auditability configuration");
  }
  if (!auditabilityEnabled && (meta.auditability || pensieveProfile)) {
    throw new Error("Stripe subscription contains invalid auditability metadata");
  }
  const configuredPrices = [config.residentPrice, config.providerCostPrice, config.markupPrice,
    ...(auditabilityEnabled ? [config.auditabilityPrice!] : [])];
  const actualPrices = data.map(itemPriceId);
  if (!subscriptionId || !customerId || !status || data.length !== configuredPrices.length || (record(subscription.items) && subscription.items.has_more === true)
    || actualPrices.some((value) => !value)
    || new Set(actualPrices).size !== configuredPrices.length
    || configuredPrices.some((price) => !actualPrices.includes(price))) {
    throw new Error("Stripe subscription does not match the resident rate card");
  }
  const residentItem = data.find((item) => itemPriceId(item) === config.residentPrice)!;
  if (id(residentItem, "si_") === null || residentItem.quantity !== 1) {
    throw new Error("Stripe resident subscription must contain exactly one resident");
  }
  const auditabilityItem = auditabilityEnabled
    ? data.find((item) => itemPriceId(item) === config.auditabilityPrice)
    : null;
  if (auditabilityEnabled && (!auditabilityItem || id(auditabilityItem, "si_") === null || auditabilityItem.quantity !== 1)) {
    throw new Error("Stripe auditability subscription must contain exactly one covered resident");
  }
  if (customerId !== account.stripeCustomerId
    || meta.billing_account_id !== account.id
    || meta.tenant_key !== account.tenantKey
    || meta.github_account_id !== account.githubAccountId
    || meta.starting_workflow !== "issue-triage") {
    throw new Error("Stripe subscription metadata does not match the authorized tenant");
  }
  if (checkout) {
    if (id(checkout.customer, "cus_") !== customerId || id(checkout.subscription, "sub_") !== subscriptionId
      || checkout.mode !== "subscription" || metadata(checkout).billing_account_id !== account.id
      || metadata(checkout).auditability !== meta.auditability) {
      throw new Error("Stripe Checkout Session does not match the subscription");
    }
    if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)
      && (checkout.status !== "complete" || !["paid", "no_payment_required"].includes(String(checkout.payment_status)))) {
      throw new Error("Stripe Checkout Session is not paid and complete");
    }
  }
  validateDiscount(subscription, checkout, config.promotionCode, config.coupon);
  const period = subscriptionPeriod(subscription, residentItem);
  const approvedCheckout = ["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)
    ? id(checkout, "cs_") : null;
  return {
    eventId: event.id,
    eventType: event.type,
    eventCreated: event.created,
    rawJson: rawBody,
    stripeObjectJson: JSON.stringify(subscription),
    reconciledAt: now,
    authoritative: true,
    billingAccountId: account.id,
    stripeSubscriptionId: subscriptionId,
    stripeSubscriptionItemId: id(residentItem, "si_")!,
    auditabilityStripeItemId: auditabilityItem ? id(auditabilityItem, "si_") : null,
    auditabilityEnabled,
    pensieveProfile: auditabilityEnabled ? pensieveProfile : null,
    status,
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
    residentQuantity: 1,
    agentResourceName: residentAgentName(account, config.residentAgentNameOverrides),
    personaLogin: null,
    provisioningApprovalActor: approvedCheckout ? `stripe-checkout:${approvedCheckout}` : undefined,
    provisioningApprovalEvidenceJson: approvedCheckout ? JSON.stringify({
      checkoutSessionId: approvedCheckout,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      paymentStatus: checkout?.payment_status,
    }) : undefined,
    receivedAt: now,
  };
}

async function retrieveCheckout(sessionId: string, secret: string, stripeFetch: typeof fetch) {
  const query = new URLSearchParams();
  query.append("expand[]", "discounts");
  query.append("expand[]", "discounts.promotion_code");
  query.append("expand[]", "discounts.source.coupon");
  return stripeGet(`/checkout/sessions/${encodeURIComponent(sessionId)}`, secret, query, stripeFetch);
}

async function retrieveSubscription(subscriptionId: string, secret: string, stripeFetch: typeof fetch) {
  const query = new URLSearchParams();
  query.append("expand[]", "items.data.price.product");
  query.append("expand[]", "discounts");
  query.append("expand[]", "discounts.promotion_code");
  query.append("expand[]", "discounts.source.coupon");
  return stripeGet(`/subscriptions/${encodeURIComponent(subscriptionId)}`, secret, query, stripeFetch);
}

async function retrieveStripeObject(path: string, secret: string, stripeFetch: typeof fetch) {
  return stripeGet(path, secret, new URLSearchParams(), stripeFetch);
}

async function reconcileBillingReview(
  event: StripeEvent,
  rawBody: string,
  config: NonNullable<ReturnType<typeof configured>>,
  options: WebhookOptions,
  stripeFetch: typeof fetch,
  now: number,
) {
  let reviewObject: StripeRecord;
  let charge: StripeRecord;
  let reason: BillingReviewEvent["reason"];
  if (event.type === "charge.dispute.created") {
    const disputeId = id(event.data.object, "dp_");
    if (!disputeId) throw new Error("Stripe dispute event is missing its dispute ID");
    reviewObject = await retrieveStripeObject(`/disputes/${encodeURIComponent(disputeId)}`, config.secretKey, stripeFetch);
    const chargeId = id(reviewObject.charge, "ch_");
    if (!chargeId) throw new Error("Stripe dispute is missing its charge");
    charge = await retrieveStripeObject(`/charges/${encodeURIComponent(chargeId)}`, config.secretKey, stripeFetch);
    reason = "dispute";
  } else if (event.type === "charge.refunded") {
    const chargeId = id(event.data.object, "ch_");
    if (!chargeId) throw new Error("Stripe refund event is missing its charge ID");
    charge = await retrieveStripeObject(`/charges/${encodeURIComponent(chargeId)}`, config.secretKey, stripeFetch);
    reviewObject = charge;
    reason = "refund";
    const amount = integer(charge.amount);
    const amountRefunded = integer(charge.amount_refunded);
    if (charge.refunded !== true || amount === null || amount === 0 || amountRefunded !== amount) {
      return { received: true, applied: false } as const;
    }
  } else {
    const refundId = id(event.data.object, "re_");
    if (!refundId) throw new Error("Stripe refund event is missing its refund ID");
    reviewObject = await retrieveStripeObject(`/refunds/${encodeURIComponent(refundId)}`, config.secretKey, stripeFetch);
    const status = typeof reviewObject.status === "string" ? reviewObject.status : null;
    if (status !== "succeeded") {
      return { received: true, applied: false } as const;
    }
    const amount = integer(reviewObject.amount);
    if (amount === null || amount === 0) throw new Error("Stripe refund has no authoritative amount");
    const chargeId = id(reviewObject.charge, "ch_");
    if (!chargeId) throw new Error("Stripe refund is missing its charge");
    charge = await retrieveStripeObject(`/charges/${encodeURIComponent(chargeId)}`, config.secretKey, stripeFetch);
    reason = "refund";
    const chargeAmount = integer(charge.amount);
    const amountRefunded = integer(charge.amount_refunded);
    if (charge.refunded !== true || chargeAmount === null || chargeAmount === 0 || amountRefunded !== chargeAmount) {
      return { received: true, applied: false } as const;
    }
  }
  const customerId = id(charge.customer, "cus_");
  if (!customerId) throw new Error("Stripe charge is missing its customer");
  const account = await options.store.getBillingAccountByStripeCustomer(customerId);
  if (!account) return { received: true, applied: false } as const;
  const invoiceId = id(charge.invoice, "in_");
  if (!invoiceId) return { received: true, applied: false } as const;
  const invoice = await retrieveStripeObject(`/invoices/${encodeURIComponent(invoiceId)}`, config.secretKey, stripeFetch);
  if (id(invoice, "in_") !== invoiceId || id(invoice.customer, "cus_") !== customerId) {
    throw new Error("Stripe charge invoice does not match the charge customer");
  }
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) return { received: true, applied: false } as const;
  const status = await options.store.getAccountStatus(account.id);
  if (!status || status.account.id !== account.id
    || status.subscription?.stripeSubscriptionId !== subscriptionId) {
    return { received: true, applied: false } as const;
  }
  const result = await options.store.applyBillingReviewEvent({
    eventId: event.id,
    eventType: event.type,
    eventCreated: event.created,
    rawJson: rawBody,
    stripeObjectId: objectId(reviewObject)!,
    stripeObjectJson: JSON.stringify({ reviewObject, charge, invoice }),
    billingAccountId: account.id,
    reason,
    receivedAt: now,
  });
  if (result.applied && result.provisioningRequested) await options.dispatchProvisioning?.(account);
  return { received: true, applied: result.applied } as const;
}

export async function handleStripeWebhook(request: Request, env: Env, options: WebhookOptions): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const config = configured(env);
  if (!config) return json({ error: "Stripe webhook is not configured" }, 503);
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BYTES) return json({ error: "Webhook is too large" }, 413);
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_WEBHOOK_BYTES) return json({ error: "Webhook is too large" }, 413);
  const now = options.now ?? Date.now();
  if (!await verifyStripeWebhookSignature(config.webhookSecret, rawBody, request.headers.get("stripe-signature"), Math.floor(now / 1_000))) {
    return json({ error: "Invalid Stripe signature" }, 400);
  }
  let event: StripeEvent;
  try { event = parseStripeEvent(rawBody); }
  catch { return json({ error: "Invalid Stripe event" }, 400); }
  const expectedLiveMode = config.secretKey.startsWith("sk_live_");
  if (event.livemode !== expectedLiveMode) return json({ error: "Stripe event mode does not match this environment" }, 400);
  const stripeFetch = options.stripeFetch ?? fetch;
  if (BILLING_REVIEW_EVENTS.has(event.type)) {
    try {
      const result = await reconcileBillingReview(event, rawBody, config, options, stripeFetch, now);
      return json(result, result.applied ? 202 : 200);
    } catch (error) {
      console.error(JSON.stringify({ message: "Stripe billing review event could not be reconciled", eventId: event.id,
        error: error instanceof Error ? error.message : "Unexpected error" }));
      return json({ error: "Stripe webhook could not be reconciled" }, 500);
    }
  }
  const subscriptionId = eventSubscriptionId(event);
  if (!subscriptionId) return json({ received: true, applied: false }, 200);
  try {
    const checkoutId = CHECKOUT_EVENTS.has(event.type) ? id(event.data.object, "cs_") : null;
    const [subscription, checkout] = await Promise.all([
      retrieveSubscription(subscriptionId, config.secretKey, stripeFetch),
      checkoutId ? retrieveCheckout(checkoutId, config.secretKey, stripeFetch) : Promise.resolve(null),
    ]);
    const customerId = id(subscription.customer, "cus_");
    const account = customerId ? await options.store.getBillingAccountByStripeCustomer(customerId) : null;
    if (!account) throw new Error("Stripe customer is not bound to a billing account");
    const result = await options.store.applySubscriptionEvent(
      lifecycleEvent(event, rawBody, subscription, checkout, account, config, now),
    );
    if (result.applied && result.provisioningRequested) {
      await options.dispatchProvisioning?.(account);
    }
    return json({ received: true, applied: result.applied }, result.applied ? 202 : 200);
  } catch (error) {
    console.error(JSON.stringify({ message: "Stripe webhook reconciliation failed", eventId: event.id,
      error: error instanceof Error ? error.message : "Unexpected error" }));
    return json({ error: "Stripe webhook could not be reconciled" }, 500);
  }
}
