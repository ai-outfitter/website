import { describe, expect, it, vi } from "vitest";
import type { BillingAccount, CheckoutLease } from "./billing-store";
import { createCheckoutSession, type CheckoutIdentity } from "./billing";

const billingEnv = {
  STRIPE_SECRET_KEY: "sk_test_example",
  STRIPE_RESIDENT_PRICE_ID: "price_resident",
  STRIPE_PROVIDER_COST_PRICE_ID: "price_provider",
  STRIPE_MARKUP_PRICE_ID: "price_markup",
  STRIPE_AUDITABILITY_PRICE_ID: "price_auditability",
  STRIPE_NO_MARKUP_PROMOTION_CODE_ID: "promo_no_markup",
  BILLING_MARKUP_BASIS_POINTS: "2000",
  BILLING_HARD_SPEND_LIMIT_MICROS: "100000000",
  BILLING_ALERT_THRESHOLD_MICROS: "80000000",
  BILLING_RATE_CARD_VERSION: "2026-09-17",
} as unknown as Env;

const identity: CheckoutIdentity = {
  githubAccountId: 8,
  githubAccountLogin: "Unsupervisedcom",
  githubAccountType: "Organization",
  githubInstallationId: 42,
  githubUserId: 7,
  githubUserLogin: "ncrmro",
};

const account: BillingAccount = {
  id: "billing:github:organization:8",
  tenantKey: "github:organization:8",
  githubAccountId: "8",
  githubAccountLogin: "Unsupervisedcom",
  githubAccountType: "Organization",
  githubInstallationId: "42",
  createdByGitHubUserId: "7",
  createdByGitHubLogin: "ncrmro",
  stripeCustomerId: "cus_unsupervised",
  authorizationState: "authorized",
  markupBasisPoints: 2_000,
  hardSpendLimitMicros: 100_000_000,
  alertThresholdMicros: 80_000_000,
  acceptedRateCardVersion: "2026-09-17",
  createdAt: 1,
  updatedAt: 1,
};

const lease: CheckoutLease = {
  id: "checkout:one",
  billingAccountId: account.id,
  productKey: "resident:v1",
  idempotencyKey: "ai-outfitter-checkout-stable",
  stripeCheckoutSessionId: null,
  status: "pending",
  expiresAt: 1_800_001_800_000,
  createdAt: 1_800_000_000_000,
  updatedAt: 1_800_000_000_000,
};

function checkoutRequest(values: Record<string, string> = { tier: "resident" }, overrides: RequestInit = {}) {
  const body = new URLSearchParams(values).toString();
  return new Request("https://ai-outfitter.com/api/billing/checkout", {
    method: "POST",
    body,
    headers: { origin: "https://ai-outfitter.com", "content-type": "application/x-www-form-urlencoded", "content-length": String(new TextEncoder().encode(body).byteLength) },
    ...overrides,
  });
}

function makeStore(existing: BillingAccount | null = account) {
  return {
    getBillingAccountByTenant: vi.fn(async () => existing),
    refreshBillingAccountGitHubIdentity: vi.fn(async (input: {
      billingAccountId: string; githubAccountId: string; githubAccountLogin: string; githubInstallationId: string;
    }) => existing ? ({
      ...existing,
      githubAccountLogin: input.githubAccountLogin,
      githubInstallationId: input.githubInstallationId,
    }) : null),
    upsertBillingAccount: vi.fn(async (input: Omit<BillingAccount, "createdAt" | "updatedAt">) => ({ ...input, createdAt: 1, updatedAt: 1 })),
    acquireCheckoutLease: vi.fn(async () => ({ lease, reused: false })),
    attachCheckoutSession: vi.fn(async () => true),
  };
}

function checkoutResponse() {
  return new Response(JSON.stringify({ id: "cs_test_resident", url: "https://checkout.stripe.com/c/pay/test" }), {
    headers: { "content-type": "application/json", "request-id": "req_checkout" },
  });
}

describe("createCheckoutSession", () => {
  it("creates an account-bound resident subscription with separately metered inference", async () => {
    const store = makeStore();
    let call: [URL | RequestInfo, RequestInit | undefined] | null = null;
    const stripeFetch: typeof fetch = async (input, init) => { call = [input, init]; return checkoutResponse(); };
    const response = await createCheckoutSession(checkoutRequest({ tier: "resident", promotion_code: "no-markup", auditability: "enterprise" }), billingEnv, {
      identity, store, stripeFetch, now: 1_800_000_000_000, uuid: () => "unused",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://checkout.stripe.com/c/pay/test");
    expect(call).not.toBeNull();
    const [url, init] = call!;
    expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(init?.headers).toEqual(expect.objectContaining({ "idempotency-key": lease.idempotencyKey }));
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("customer")).toBe("cus_unsupervised");
    expect(body.get("client_reference_id")).toBe(account.id);
    expect(body.get("line_items[0][price]")).toBe("price_resident");
    expect(body.get("line_items[0][quantity]")).toBe("1");
    expect(body.get("line_items[1][price]")).toBe("price_provider");
    expect(body.get("line_items[1][quantity]")).toBeNull();
    expect(body.get("line_items[2][price]")).toBe("price_markup");
    expect(body.get("line_items[3][price]")).toBe("price_auditability");
    expect(body.get("line_items[3][quantity]")).toBe("1");
    expect(body.get("discounts[0][promotion_code]")).toBe("promo_no_markup");
    expect(body.get("subscription_data[metadata][starting_workflow]")).toBe("issue-triage");
    expect(body.get("subscription_data[metadata][markup_basis_points]")).toBe("2000");
    expect(body.get("subscription_data[metadata][hard_spend_limit_micros]")).toBe("100000000");
    expect(body.get("subscription_data[metadata][auditability]")).toBe("enterprise");
    expect(body.get("subscription_data[metadata][pensieve_profile]")).toBe("resident-complete-trace-v1");
    expect(body.get("success_url")).toContain("session_id={CHECKOUT_SESSION_ID}");
    expect(store.refreshBillingAccountGitHubIdentity).toHaveBeenCalledWith({
      billingAccountId: account.id,
      githubAccountId: "8",
      githubAccountLogin: "Unsupervisedcom",
      githubInstallationId: "42",
    });
    expect(store.attachCheckoutSession).toHaveBeenCalledWith(lease.id, "cs_test_resident", 1_800_000_000_000);
  });

  it("creates one deterministic Stripe customer and persists the accepted billing policy", async () => {
    const store = makeStore(null);
    const calls: Array<[string, RequestInit | undefined]> = [];
    const stripeFetch: typeof fetch = async (input, init) => {
      calls.push([String(input), init]);
      return String(input).endsWith("/customers")
        ? Response.json({ id: "cus_created" }, { headers: { "request-id": "req_customer" } })
        : checkoutResponse();
    };
    const response = await createCheckoutSession(checkoutRequest(), billingEnv, { identity, store, stripeFetch, now: 1_800_000_000_000, uuid: () => "new" });
    expect(response.status).toBe(303);
    const customer = calls[0];
    expect(customer[0]).toBe("https://api.stripe.com/v1/customers");
    expect(customer[1]?.headers).toEqual(expect.objectContaining({ "idempotency-key": "ai-outfitter-customer-organization-8" }));
    expect(store.upsertBillingAccount).toHaveBeenCalledWith(expect.objectContaining({
      tenantKey: "github:organization:8", githubInstallationId: "42", stripeCustomerId: "cus_created",
      markupBasisPoints: 2_000, hardSpendLimitMicros: 100_000_000,
      alertThresholdMicros: 80_000_000, acceptedRateCardVersion: "2026-09-17",
    }));
  });

  it("rejects unknown plans and promotion codes before contacting Stripe", async () => {
    const stripeFetch = vi.fn();
    const store = makeStore();
    expect((await createCheckoutSession(checkoutRequest({ tier: "team" }), billingEnv, { identity, store, stripeFetch })).status).toBe(400);
    expect((await createCheckoutSession(checkoutRequest({ tier: "resident", promotion_code: "OTHER" }), billingEnv, { identity, store, stripeFetch })).status).toBe(400);
    expect((await createCheckoutSession(checkoutRequest({ tier: "resident", auditability: "unknown" }), billingEnv, { identity, store, stripeFetch })).status).toBe(400);
    expect(stripeFetch).not.toHaveBeenCalled();
  });

  it("rejects cross-origin, unbounded, and non-form requests", async () => {
    const options = { identity, store: makeStore(), stripeFetch: vi.fn() };
    expect((await createCheckoutSession(checkoutRequest(undefined, { headers: { origin: "https://attacker.example", "content-type": "application/x-www-form-urlencoded", "content-length": "13" } }), billingEnv, options)).status).toBe(403);
    expect((await createCheckoutSession(checkoutRequest(undefined, { headers: { origin: "https://ai-outfitter.com", "content-type": "application/json", "content-length": "2" } }), billingEnv, options)).status).toBe(415);
    expect((await createCheckoutSession(checkoutRequest(undefined, { headers: { origin: "https://ai-outfitter.com", "content-type": "application/x-www-form-urlencoded" } }), billingEnv, options)).status).toBe(411);
  });

  it("fails closed when configuration or GitHub installation identity is missing", async () => {
    expect((await createCheckoutSession(checkoutRequest(), {} as Env, { identity, store: makeStore(), stripeFetch: vi.fn() })).status).toBe(503);
    expect((await createCheckoutSession(checkoutRequest(), billingEnv, { identity: { ...identity, githubInstallationId: 0 }, store: makeStore(), stripeFetch: vi.fn() })).status).toBe(400);
  });

  it("does not sell a resident subscription to a personal account", async () => {
    const stripeFetch = vi.fn();
    const store = makeStore();
    const response = await createCheckoutSession(checkoutRequest(), billingEnv, {
      identity: { ...identity, githubAccountType: "User" }, store, stripeFetch,
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Resident subscriptions require a GitHub organization" });
    expect(stripeFetch).not.toHaveBeenCalled();
    expect(store.acquireCheckoutLease).not.toHaveBeenCalled();
  });

  it("does not create a second checkout for an active resident subscription", async () => {
    const store = makeStore();
    store.acquireCheckoutLease.mockRejectedValueOnce(new Error("An active resident subscription already exists"));
    const stripeFetch = vi.fn();
    const response = await createCheckoutSession(checkoutRequest(), billingEnv, { identity, store, stripeFetch });
    expect(response.status).toBe(409);
    expect(stripeFetch).not.toHaveBeenCalled();
  });

  it("does not redirect to an unexpected or incomplete Stripe response", async () => {
    const store = makeStore();
    const stripeFetch: typeof fetch = async () => Response.json({ id: "cs_test", url: "https://example.com/redirect" });
    expect((await createCheckoutSession(checkoutRequest(), billingEnv, { identity, store, stripeFetch })).status).toBe(502);
    expect(store.attachCheckoutSession).not.toHaveBeenCalled();
  });
});
