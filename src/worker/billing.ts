import type { BillingAccount, BillingStore, CheckoutLease } from "./billing-store";

const CHECKOUT_BODY_LIMIT = 256;
const CHECKOUT_LEASE_MS = 30 * 60 * 1_000;
const STRIPE_API = "https://api.stripe.com/v1";
const STRIPE_API_VERSION = "2025-03-31.basil";
const STRIPE_CHECKOUT_ORIGIN = "https://checkout.stripe.com";
const RESIDENT_PRODUCT_KEY = "resident:v1";
const AUDITABILITY_PLAN = "enterprise";
const NO_MARKUP_CODE = "NO-MARKUP";

export type CheckoutIdentity = {
  githubAccountId: number;
  githubAccountLogin: string;
  githubAccountType: "Organization" | "User";
  githubInstallationId: number;
  githubUserId: number;
  githubUserLogin: string;
};

type CheckoutStore = Pick<BillingStore,
  "getBillingAccountByTenant" | "refreshBillingAccountGitHubIdentity" | "upsertBillingAccount" | "acquireCheckoutLease" | "attachCheckoutSession"
>;

type CheckoutOptions = {
  identity: CheckoutIdentity;
  store: CheckoutStore;
  stripeFetch?: typeof fetch;
  now?: number;
  uuid?: () => string;
};

function json(value: unknown, status: number, headers?: HeadersInit) {
  return Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } });
}

function configuredValue(value: string | undefined) { return value?.trim() || null; }
function configuredInteger(value: string | undefined) {
  const normalized = configuredValue(value);
  if (!normalized || !/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function checkoutUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return url.origin === STRIPE_CHECKOUT_ORIGIN ? url : null; }
  catch { return null; }
}

function stripeId(value: unknown, prefix: string) {
  return typeof value === "string" && value.startsWith(prefix) ? value : null;
}

function basicAuthorization(secretKey: string) { return `Basic ${btoa(`${secretKey}:`)}`; }

async function stripePost(path: string, secretKey: string, body: URLSearchParams, idempotencyKey: string, stripeFetch: typeof fetch) {
  return stripeFetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: { authorization: basicAuthorization(secretKey), "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": idempotencyKey, "stripe-version": STRIPE_API_VERSION },
    body,
  });
}

function tenantKey(identity: CheckoutIdentity) { return `github:${identity.githubAccountType.toLowerCase()}:${identity.githubAccountId}`; }
function billingAccountId(identity: CheckoutIdentity) { return `billing:${tenantKey(identity)}`; }

function checkoutConfiguration(env: Env) {
  const values = {
    secretKey: configuredValue(env.STRIPE_SECRET_KEY),
    residentPrice: configuredValue(env.STRIPE_RESIDENT_PRICE_ID),
    providerCostPrice: configuredValue(env.STRIPE_PROVIDER_COST_PRICE_ID),
    markupPrice: configuredValue(env.STRIPE_MARKUP_PRICE_ID),
    auditabilityPrice: configuredValue(env.STRIPE_AUDITABILITY_PRICE_ID),
    auditabilityCheckoutEnabled: configuredValue(env.AUDITABILITY_CHECKOUT_ENABLED) === "true",
    noMarkupPromotion: configuredValue(env.STRIPE_NO_MARKUP_PROMOTION_CODE_ID),
    markupBasisPoints: configuredInteger(env.BILLING_MARKUP_BASIS_POINTS),
    hardSpendLimitMicros: configuredInteger(env.BILLING_HARD_SPEND_LIMIT_MICROS),
    alertThresholdMicros: configuredInteger(env.BILLING_ALERT_THRESHOLD_MICROS),
    rateCardVersion: configuredValue(env.BILLING_RATE_CARD_VERSION),
  };
  const required = values.secretKey && values.residentPrice && values.providerCostPrice && values.markupPrice
    && values.markupBasisPoints !== null && values.hardSpendLimitMicros !== null
    && values.alertThresholdMicros !== null && values.rateCardVersion;
  const limitsValid = values.hardSpendLimitMicros !== null && values.alertThresholdMicros !== null
    && values.alertThresholdMicros <= values.hardSpendLimitMicros;
  return required && limitsValid ? values : null;
}

async function ensureStripeCustomer(identity: CheckoutIdentity, secretKey: string, store: CheckoutStore, env: Env, stripeFetch: typeof fetch) {
  const key = tenantKey(identity);
  const existing = await store.getBillingAccountByTenant(key);
  if (existing) {
    if (existing.authorizationState !== "authorized") throw new Error("Billing account is not authorized");
    const refreshed = await store.refreshBillingAccountGitHubIdentity({
      billingAccountId: existing.id,
      githubAccountId: String(identity.githubAccountId),
      githubAccountLogin: identity.githubAccountLogin,
      githubInstallationId: String(identity.githubInstallationId),
    });
    if (!refreshed) throw new Error("Billing account identity could not be refreshed");
    return refreshed;
  }
  const body = new URLSearchParams({
    name: identity.githubAccountLogin,
    "metadata[tenant_key]": key,
    "metadata[github_account_id]": String(identity.githubAccountId),
    "metadata[github_account_login]": identity.githubAccountLogin,
    "metadata[github_account_type]": identity.githubAccountType,
  });
  const response = await stripePost("/customers", secretKey, body, `ai-outfitter-customer-${identity.githubAccountType.toLowerCase()}-${identity.githubAccountId}`, stripeFetch);
  const requestId = response.headers.get("request-id");
  const value: unknown = await response.json().catch(() => null);
  const customerId = value && typeof value === "object" && !Array.isArray(value) && "id" in value ? stripeId(value.id, "cus_") : null;
  if (!response.ok || !customerId) {
    console.error(JSON.stringify({ message: "Stripe customer creation failed", status: response.status, stripeRequestId: requestId }));
    throw new Error("Stripe could not create a billing customer");
  }
  const account = await store.upsertBillingAccount({
    id: billingAccountId(identity), tenantKey: key, githubAccountId: String(identity.githubAccountId),
    githubAccountLogin: identity.githubAccountLogin, githubAccountType: identity.githubAccountType,
    githubInstallationId: String(identity.githubInstallationId), createdByGitHubUserId: String(identity.githubUserId),
    createdByGitHubLogin: identity.githubUserLogin, stripeCustomerId: customerId, authorizationState: "authorized",
    markupBasisPoints: configuredInteger(env.BILLING_MARKUP_BASIS_POINTS)!, hardSpendLimitMicros: configuredInteger(env.BILLING_HARD_SPEND_LIMIT_MICROS),
    alertThresholdMicros: configuredInteger(env.BILLING_ALERT_THRESHOLD_MICROS), acceptedRateCardVersion: configuredValue(env.BILLING_RATE_CARD_VERSION)!,
  });
  if (!account) throw new Error("Billing account was not persisted");
  return account;
}

function checkoutBody(
  requestUrl: URL,
  account: BillingAccount,
  config: NonNullable<ReturnType<typeof checkoutConfiguration>>,
  promotionCode: string,
  auditabilityEnabled: boolean,
) {
  const body = new URLSearchParams({
    mode: "subscription", customer: account.stripeCustomerId, client_reference_id: account.id,
    "line_items[0][price]": config.residentPrice!, "line_items[0][quantity]": "1",
    "line_items[1][price]": config.providerCostPrice!, "line_items[2][price]": config.markupPrice!,
    success_url: `${requestUrl.origin}/checkout/success/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${requestUrl.origin}/pricing/`,
    "metadata[billing_account_id]": account.id, "metadata[tenant_key]": account.tenantKey,
    "metadata[github_account_id]": account.githubAccountId, "metadata[starting_workflow]": "issue-triage",
    "subscription_data[metadata][billing_account_id]": account.id,
    "subscription_data[metadata][tenant_key]": account.tenantKey,
    "subscription_data[metadata][github_account_id]": account.githubAccountId,
    "subscription_data[metadata][starting_workflow]": "issue-triage",
    "subscription_data[metadata][rate_card_version]": account.acceptedRateCardVersion,
    "subscription_data[metadata][markup_basis_points]": String(account.markupBasisPoints),
    "subscription_data[metadata][hard_spend_limit_micros]": String(account.hardSpendLimitMicros),
  });
  if (auditabilityEnabled) {
    body.set("line_items[3][price]", config.auditabilityPrice!);
    body.set("line_items[3][quantity]", "1");
    body.set("metadata[auditability]", AUDITABILITY_PLAN);
    body.set("subscription_data[metadata][auditability]", AUDITABILITY_PLAN);
    body.set("subscription_data[metadata][pensieve_profile]", "resident-complete-trace-v1");
  }
  if (promotionCode === NO_MARKUP_CODE) {
    body.set("discounts[0][promotion_code]", config.noMarkupPromotion!);
    body.set("metadata[markup_promotion]", "no-markup");
    body.set("subscription_data[metadata][markup_promotion]", "no-markup");
  }
  return body;
}

export async function createCheckoutSession(request: Request, env: Env, options: CheckoutOptions): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { allow: "POST" });
  const requestUrl = new URL(request.url);
  if (request.headers.get("origin") !== requestUrl.origin) return json({ error: "Checkout must be started from this site" }, 403);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/x-www-form-urlencoded") return json({ error: "Checkout requires form data" }, 415);
  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = contentLengthHeader === null ? Number.NaN : Number(contentLengthHeader);
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) return json({ error: "Checkout requires a content length" }, 411);
  if (contentLength > CHECKOUT_BODY_LIMIT) return json({ error: "Checkout request is too large" }, 413);
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > CHECKOUT_BODY_LIMIT) return json({ error: "Checkout request is too large" }, 413);
  const form = new URLSearchParams(rawBody);
  if (form.get("tier") !== "resident") return json({ error: "Choose the resident plan" }, 400);
  const promotionCode = (form.get("promotion_code") ?? "").trim().toUpperCase();
  if (promotionCode && promotionCode !== NO_MARKUP_CODE) return json({ error: "Promotion code is not valid for this offer" }, 400);
  const config = checkoutConfiguration(env);
  const auditability = (form.get("auditability") ?? "").trim();
  if (auditability && auditability !== AUDITABILITY_PLAN) return json({ error: "Choose a supported auditability plan" }, 400);
  const auditabilityEnabled = auditability === AUDITABILITY_PLAN;
  if (auditabilityEnabled && !config?.auditabilityCheckoutEnabled) {
    return json({ error: "Enterprise auditability checkout is not open yet" }, 409);
  }
  if (!config || (promotionCode === NO_MARKUP_CODE && !config.noMarkupPromotion)
    || (auditabilityEnabled && !config.auditabilityPrice)) return json({ error: "Checkout is not configured" }, 503);
  const { identity, store } = options;
  if (identity.githubAccountType !== "Organization") {
    return json({ error: "Resident subscriptions require a GitHub organization" }, 400);
  }
  if (!Number.isSafeInteger(identity.githubAccountId) || identity.githubAccountId <= 0
    || !Number.isSafeInteger(identity.githubInstallationId) || identity.githubInstallationId <= 0
    || !Number.isSafeInteger(identity.githubUserId) || identity.githubUserId <= 0) {
    return json({ error: "Checkout requires an installed GitHub account" }, 400);
  }
  const stripeFetch = options.stripeFetch ?? fetch;
  let account: BillingAccount;
  try { account = await ensureStripeCustomer(identity, config.secretKey!, store, env, stripeFetch); }
  catch (error) {
    console.error(JSON.stringify({ message: "Billing account setup failed", error: error instanceof Error ? error.message : "Unexpected error" }));
    return json({ error: "Stripe could not start checkout" }, 502);
  }
  if (account.hardSpendLimitMicros === null || account.alertThresholdMicros === null) {
    return json({ error: "This billing account must accept the current spend policy before checkout" }, 409);
  }
  const now = options.now ?? Date.now();
  const uuid = options.uuid ?? crypto.randomUUID.bind(crypto);
  let lease: CheckoutLease;
  try {
    ({ lease } = await store.acquireCheckoutLease({ id: `checkout:${uuid()}`, billingAccountId: account.id,
      productKey: RESIDENT_PRODUCT_KEY,
      idempotencyKey: `ai-outfitter-checkout-${uuid()}`,
      expiresAt: now + CHECKOUT_LEASE_MS, now }));
  } catch (error) {
    const conflict = error instanceof Error && /active resident subscription/i.test(error.message);
    return json({ error: conflict ? "This account already has a resident subscription" : "Checkout could not be reserved" }, conflict ? 409 : 503);
  }
  let stripeResponse: Response;
  try { stripeResponse = await stripePost("/checkout/sessions", config.secretKey!, checkoutBody(requestUrl, account, config, promotionCode, auditabilityEnabled), lease.idempotencyKey, stripeFetch); }
  catch {
    console.error(JSON.stringify({ message: "Stripe checkout session request failed" }));
    return json({ error: "Stripe could not start checkout" }, 502);
  }
  const stripeRequestId = stripeResponse.headers.get("request-id");
  const session: unknown = await stripeResponse.json().catch(() => null);
  const sessionId = session && typeof session === "object" && !Array.isArray(session) && "id" in session ? stripeId(session.id, "cs_") : null;
  const location = checkoutUrl(session && typeof session === "object" && !Array.isArray(session) && "url" in session ? session.url : null);
  if (!stripeResponse.ok || !sessionId || !location) {
    console.error(JSON.stringify({ message: "Stripe checkout session creation failed", status: stripeResponse.status, stripeRequestId }));
    return json({ error: "Stripe could not start checkout" }, 502);
  }
  if (!await store.attachCheckoutSession(lease.id, sessionId, now)) {
    console.error(JSON.stringify({ message: "Stripe checkout session lease was lost", stripeRequestId, checkoutSessionId: sessionId }));
    return json({ error: "Stripe could not start checkout" }, 502);
  }
  return Response.redirect(location, 303);
}
