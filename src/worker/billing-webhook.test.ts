import { describe, expect, it, vi } from "vitest";

import { handleStripeWebhook } from "./billing-webhook";
import type { BillingAccount, SubscriptionLifecycleEvent } from "./billing-store";
import { stripeSignature } from "./stripe-webhook";

const NOW = 2_000_000_000_000;
const SECRET = "whsec_test_webhook";

const env = {
  STRIPE_SECRET_KEY: "sk_test_example",
  STRIPE_WEBHOOK_SECRET: SECRET,
  STRIPE_RESIDENT_PRICE_ID: "price_resident",
  STRIPE_PROVIDER_COST_PRICE_ID: "price_provider",
  STRIPE_MARKUP_PRICE_ID: "price_markup",
  STRIPE_AUDITABILITY_PRICE_ID: "price_auditability",
  STRIPE_NO_MARKUP_COUPON_ID: "ai_outfitter_no_markup_forever_v2",
  STRIPE_NO_MARKUP_PROMOTION_CODE_ID: "promo_no_markup",
} as Env;

const account: BillingAccount = {
  id: "billing:github:organization:123",
  tenantKey: "github:organization:123",
  githubAccountId: "123",
  githubAccountLogin: "Unsupervisedcom",
  githubAccountType: "Organization",
  githubInstallationId: "456",
  createdByGitHubUserId: "789",
  createdByGitHubLogin: "ncrmro",
  stripeCustomerId: "cus_customer",
  authorizationState: "authorized",
  markupBasisPoints: 2_000,
  hardSpendLimitMicros: 100_000_000,
  alertThresholdMicros: 80_000_000,
  acceptedRateCardVersion: "2026-09-17",
  createdAt: NOW,
  updatedAt: NOW,
};

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_resident",
    customer: "cus_customer",
    status: "active",
    current_period_start: 1_999_999_000,
    current_period_end: 2_002_591_000,
    cancel_at_period_end: false,
    metadata: {
      billing_account_id: account.id,
      tenant_key: account.tenantKey,
      github_account_id: account.githubAccountId,
      starting_workflow: "issue-triage",
    },
    items: { data: [
      { id: "si_resident", price: { id: "price_resident", product: { id: "prod_resident" } }, quantity: 1 },
      { id: "si_provider", price: { id: "price_provider", product: { id: "prod_provider" } } },
      { id: "si_markup", price: { id: "price_markup", product: { id: "prod_markup" } } },
    ] },
    discounts: [],
    ...overrides,
  };
}

function stripeFetchFor(value = subscription()) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/v1/subscriptions/sub_resident") return Response.json(value);
    if (url.pathname === "/v1/checkout/sessions/cs_checkout") return Response.json({
      id: "cs_checkout", mode: "subscription", status: "complete", payment_status: "paid",
      customer: "cus_customer", subscription: "sub_resident",
      metadata: { billing_account_id: account.id }, discounts: [],
    });
    return Response.json({ error: { message: "not found" } }, { status: 404 });
  });
}

async function signedRequest(type = "checkout.session.completed", object: Record<string, unknown> = {
  id: "cs_checkout", subscription: "sub_resident",
}) {
  const body = JSON.stringify({ id: "evt_test", type, created: 2_000_000_000, livemode: false, data: { object } });
  const signature = await stripeSignature(SECRET, 2_000_000_000, body);
  return new Request("https://example.com/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": `t=2000000000,v1=${signature}`, "content-type": "application/json" },
    body,
  });
}

describe("Stripe billing webhook", () => {
  it("rejects an invalid signature without calling Stripe or D1", async () => {
    const stripeFetch = stripeFetchFor();
    const store = { getBillingAccountByStripeCustomer: vi.fn(), applySubscriptionEvent: vi.fn() };
    const request = await signedRequest();
    request.headers.set("stripe-signature", "t=2000000000,v1=" + "0".repeat(64));
    const response = await handleStripeWebhook(request, env, { store: store as never, stripeFetch, now: NOW });
    expect(response.status).toBe(400);
    expect(stripeFetch).not.toHaveBeenCalled();
    expect(store.applySubscriptionEvent).not.toHaveBeenCalled();
  });

  it("acknowledges unrelated signed events without reconciliation", async () => {
    const stripeFetch = stripeFetchFor();
    const store = { getBillingAccountByStripeCustomer: vi.fn(), applySubscriptionEvent: vi.fn() };
    const response = await handleStripeWebhook(await signedRequest("payment_intent.succeeded", { id: "pi_test" }), env,
      { store: store as never, stripeFetch, now: NOW });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, applied: false });
    expect(stripeFetch).not.toHaveBeenCalled();
  });

  it("retrieves and validates authoritative Stripe state before granting the resident", async () => {
    let applied: SubscriptionLifecycleEvent | null = null;
    const store = {
      getBillingAccountByStripeCustomer: vi.fn(async () => account),
      applySubscriptionEvent: vi.fn(async (event: SubscriptionLifecycleEvent) => { applied = event; return { applied: true }; }),
    };
    const stripeFetch = stripeFetchFor();
    const response = await handleStripeWebhook(await signedRequest(), env, { store: store as never, stripeFetch, now: NOW });
    expect(response.status).toBe(202);
    expect(stripeFetch).toHaveBeenCalledTimes(2);
    expect(applied).toMatchObject({
      billingAccountId: account.id,
      stripeSubscriptionId: "sub_resident",
      stripeSubscriptionItemId: "si_resident",
      auditabilityStripeItemId: null,
      auditabilityEnabled: false,
      pensieveProfile: null,
      status: "active",
      residentQuantity: 1,
      agentResourceName: "unsupervisedcom-luce-123",
      authoritative: true,
    });
  });

  it("derives a Pensieve entitlement only from the configured auditability line", async () => {
    let applied: SubscriptionLifecycleEvent | null = null;
    const store = {
      getBillingAccountByStripeCustomer: vi.fn(async () => account),
      applySubscriptionEvent: vi.fn(async (event: SubscriptionLifecycleEvent) => { applied = event; return { applied: true }; }),
    };
    const audited = subscription({
      metadata: {
        billing_account_id: account.id,
        tenant_key: account.tenantKey,
        github_account_id: account.githubAccountId,
        starting_workflow: "issue-triage",
        auditability: "enterprise",
        pensieve_profile: "resident-complete-trace-v1",
      },
      items: { data: [
        { id: "si_resident", price: { id: "price_resident", product: { id: "prod_resident" } }, quantity: 1 },
        { id: "si_provider", price: { id: "price_provider", product: { id: "prod_provider" } } },
        { id: "si_markup", price: { id: "price_markup", product: { id: "prod_markup" } } },
        { id: "si_audit", price: { id: "price_auditability", product: { id: "prod_audit" } }, quantity: 1 },
      ] },
    });
    const stripeFetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/v1/subscriptions/sub_resident") return Response.json(audited);
      if (url.pathname === "/v1/checkout/sessions/cs_checkout") return Response.json({
        id: "cs_checkout", mode: "subscription", status: "complete", payment_status: "paid",
        customer: "cus_customer", subscription: "sub_resident",
        metadata: { billing_account_id: account.id, auditability: "enterprise" }, discounts: [],
      });
      return Response.json({ error: { message: "not found" } }, { status: 404 });
    });
    const response = await handleStripeWebhook(await signedRequest(), env, { store: store as never, stripeFetch, now: NOW });
    expect(response.status).toBe(202);
    expect(applied).toMatchObject({
      auditabilityStripeItemId: "si_audit",
      auditabilityEnabled: true,
      pensieveProfile: "resident-complete-trace-v1",
    });
  });

  it("does not grant entitlement when the subscription price set differs", async () => {
    const wrong = subscription({ items: { data: [
      { id: "si_resident", price: "price_resident", quantity: 1 },
      { id: "si_provider", price: "price_provider" },
      { id: "si_other", price: "price_other" },
    ] } });
    const store = {
      getBillingAccountByStripeCustomer: vi.fn(async () => account),
      applySubscriptionEvent: vi.fn(),
    };
    const response = await handleStripeWebhook(await signedRequest(), env,
      { store: store as never, stripeFetch: stripeFetchFor(wrong), now: NOW });
    expect(response.status).toBe(500);
    expect(store.applySubscriptionEvent).not.toHaveBeenCalled();
  });

  it("requires the configured markup promotion when metadata claims no markup", async () => {
    const value = subscription({
      metadata: { ...subscription().metadata, markup_promotion: "no-markup" },
      discounts: [],
    });
    const store = {
      getBillingAccountByStripeCustomer: vi.fn(async () => account),
      applySubscriptionEvent: vi.fn(),
    };
    const response = await handleStripeWebhook(await signedRequest("customer.subscription.updated", { id: "sub_resident" }), env,
      { store: store as never, stripeFetch: stripeFetchFor(value), now: NOW });
    expect(response.status).toBe(500);
    expect(store.applySubscriptionEvent).not.toHaveBeenCalled();
  });

  it("accepts only the configured markup-only coupon and promotion evidence", async () => {
    const value = subscription({
      metadata: { ...subscription().metadata, markup_promotion: "no-markup" },
      discounts: [{
        id: "di_no_markup",
        promotion_code: { id: "promo_no_markup" },
        source: { type: "coupon", coupon: { id: "ai_outfitter_no_markup_forever_v2" } },
      }],
    });
    const store = {
      getBillingAccountByStripeCustomer: vi.fn(async () => account),
      applySubscriptionEvent: vi.fn(async () => ({ applied: true })),
    };
    const response = await handleStripeWebhook(await signedRequest("customer.subscription.updated", { id: "sub_resident" }), env,
      { store: store as never, stripeFetch: stripeFetchFor(value), now: NOW });
    expect(response.status).toBe(202);
    expect(store.applySubscriptionEvent).toHaveBeenCalledOnce();
  });

  it("treats asynchronous payment success as Checkout approval and dispatches provisioning", async () => {
    let applied: SubscriptionLifecycleEvent | null = null;
    const dispatchProvisioning = vi.fn(async () => undefined);
    const store = {
      getBillingAccountByStripeCustomer: vi.fn(async () => account),
      applySubscriptionEvent: vi.fn(async (event: SubscriptionLifecycleEvent) => {
        applied = event;
        return { applied: true, provisioningRequested: true };
      }),
    };
    const response = await handleStripeWebhook(
      await signedRequest("checkout.session.async_payment_succeeded"), env,
      { store: store as never, stripeFetch: stripeFetchFor(), dispatchProvisioning, now: NOW },
    );
    expect(response.status).toBe(202);
    expect(applied).toMatchObject({
      eventType: "checkout.session.async_payment_succeeded",
      provisioningApprovalActor: "stripe-checkout:cs_checkout",
    });
    expect(dispatchProvisioning).toHaveBeenCalledWith(account);
  });

  it("dispatches durable lifecycle reconciliation work for suspension", async () => {
    const dispatchProvisioning = vi.fn(async () => undefined);
    const store = {
      getBillingAccountByStripeCustomer: vi.fn(async () => account),
      applySubscriptionEvent: vi.fn(async () => ({ applied: true, provisioningRequested: true })),
    };
    const response = await handleStripeWebhook(
      await signedRequest("customer.subscription.updated", { id: "sub_resident" }), env,
      { store: store as never, stripeFetch: stripeFetchFor(subscription({ status: "past_due" })), dispatchProvisioning, now: NOW },
    );
    expect(response.status).toBe(202);
    expect(dispatchProvisioning).toHaveBeenCalledWith(account);
  });

  it("authoritatively retrieves a dispute and charge before suspending for billing review", async () => {
    const dispatchProvisioning = vi.fn(async () => undefined);
    const applyBillingReviewEvent = vi.fn(async () => ({ applied: true, provisioningRequested: true }));
    const store = {
      getBillingAccountByStripeCustomer: vi.fn(async () => account),
      applySubscriptionEvent: vi.fn(),
      applyBillingReviewEvent,
    };
    const stripeFetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/v1/disputes/dp_review") {
        return Response.json({ id: "dp_review", charge: "ch_review", status: "needs_response" });
      }
      if (url.pathname === "/v1/charges/ch_review") {
        return Response.json({ id: "ch_review", customer: "cus_customer" });
      }
      return Response.json({ error: { message: "not found" } }, { status: 404 });
    });
    const response = await handleStripeWebhook(
      await signedRequest("charge.dispute.created", { id: "dp_review" }), env,
      { store: store as never, stripeFetch, dispatchProvisioning, now: NOW },
    );
    expect(response.status).toBe(202);
    expect(stripeFetch).toHaveBeenCalledTimes(2);
    expect(applyBillingReviewEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventId: "evt_test",
      eventType: "charge.dispute.created",
      stripeObjectId: "dp_review",
      billingAccountId: account.id,
      reason: "dispute",
    }));
    expect(dispatchProvisioning).toHaveBeenCalledWith(account);
  });

  it("fails closed when an authoritative refunded charge cannot be bound to a customer", async () => {
    const store = {
      getBillingAccountByStripeCustomer: vi.fn(),
      applySubscriptionEvent: vi.fn(),
      applyBillingReviewEvent: vi.fn(),
    };
    const stripeFetch = vi.fn(async () => Response.json({
      id: "ch_refunded", amount_refunded: 2_000, customer: null,
    }));
    const response = await handleStripeWebhook(
      await signedRequest("charge.refunded", { id: "ch_refunded" }), env,
      { store: store as never, stripeFetch, now: NOW },
    );
    expect(response.status).toBe(500);
    expect(store.applyBillingReviewEvent).not.toHaveBeenCalled();
  });

  it("ignores an authoritatively failed refund without suspending the customer", async () => {
    const store = {
      getBillingAccountByStripeCustomer: vi.fn(),
      applySubscriptionEvent: vi.fn(),
      applyBillingReviewEvent: vi.fn(),
    };
    const stripeFetch = vi.fn(async () => Response.json({
      id: "re_failed", charge: "ch_review", amount: 2_000, status: "failed",
    }));
    const response = await handleStripeWebhook(
      await signedRequest("refund.updated", { id: "re_failed" }), env,
      { store: store as never, stripeFetch, now: NOW },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, applied: false });
    expect(store.getBillingAccountByStripeCustomer).not.toHaveBeenCalled();
    expect(store.applyBillingReviewEvent).not.toHaveBeenCalled();
  });
});
