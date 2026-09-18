import { describe, expect, it, vi } from "vitest";
import { reconcileStripeSubscriptions } from "./subscription-reconciliation";
import type {
  BillingAccount,
  SubscriptionLifecycleEvent,
  SubscriptionReconciliationCandidate,
} from "./billing-store";

const NOW = 2_000_000_000_000;

function candidate(overrides: Partial<SubscriptionReconciliationCandidate> = {}): SubscriptionReconciliationCandidate {
  return {
    stripeSubscriptionId: "sub_resident",
    billingAccountId: "account_1",
    githubAccountId: "123",
    reconciliationFailureCount: 0,
    ...overrides,
  };
}

const account: BillingAccount = {
  id: "account_1",
  tenantKey: "github:organization:123",
  githubAccountId: "123",
  githubAccountLogin: "example",
  githubAccountType: "Organization",
  githubInstallationId: "456",
  createdByGitHubUserId: "789",
  createdByGitHubLogin: "owner",
  stripeCustomerId: "cus_customer",
  authorizationState: "authorized",
  markupBasisPoints: 2_000,
  hardSpendLimitMicros: 100_000_000,
  alertThresholdMicros: 80_000_000,
  acceptedRateCardVersion: "2026-09-17",
  createdAt: NOW,
  updatedAt: NOW,
};

const env = {
  STRIPE_SECRET_KEY: "sk_test_example",
  STRIPE_WEBHOOK_SECRET: "whsec_example",
  STRIPE_RESIDENT_PRICE_ID: "price_resident",
  STRIPE_PROVIDER_COST_PRICE_ID: "price_provider",
  STRIPE_MARKUP_PRICE_ID: "price_markup",
  STRIPE_NO_MARKUP_COUPON_ID: "coupon_no_markup",
  STRIPE_NO_MARKUP_PROMOTION_CODE_ID: "promo_no_markup",
} as Env;

describe("scheduled Stripe subscription reconciliation", () => {
  it("isolates account failures and persists bounded retry schedules", async () => {
    const candidates = [
      candidate({ billingAccountId: "account_1", githubAccountId: "github-1", reconciliationFailureCount: 2 }),
      candidate({ stripeSubscriptionId: "sub_2", billingAccountId: "account_2", githubAccountId: "github-2" }),
    ];
    const listSubscriptionReconciliationCandidates = vi.fn().mockResolvedValue(candidates);
    const recordSubscriptionReconciliationAttempt = vi.fn().mockResolvedValue(true);
    const reconcile = vi.fn(async (item: SubscriptionReconciliationCandidate) => {
      if (item.billingAccountId === "account_1") throw new Error("Stripe unavailable");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = { listSubscriptionReconciliationCandidates, recordSubscriptionReconciliationAttempt };

    await expect(reconcileStripeSubscriptions({} as Env, {
      store: store as never,
      reconcile,
      now: NOW,
      limit: 2,
    })).resolves.toEqual({ scanned: 2, reconciled: 1, failed: 1 });

    expect(listSubscriptionReconciliationCandidates).toHaveBeenCalledWith(NOW, 2);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(recordSubscriptionReconciliationAttempt).toHaveBeenCalledWith(expect.objectContaining({
      billingAccountId: "account_1",
      succeeded: false,
      nextAttemptAt: NOW + 20 * 60 * 1_000,
      error: "Stripe unavailable",
    }));
    expect(recordSubscriptionReconciliationAttempt).toHaveBeenCalledWith(expect.objectContaining({
      billingAccountId: "account_2",
      succeeded: true,
      nextAttemptAt: NOW + 15 * 60 * 1_000,
    }));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('"githubAccountId":"github-1"'));
    error.mockRestore();
  });

  it("uses the signed webhook lifecycle path and pinned Stripe API version", async () => {
    const applied: SubscriptionLifecycleEvent[] = [];
    const listSubscriptionReconciliationCandidates = vi.fn().mockResolvedValue([candidate()]);
    const recordSubscriptionReconciliationAttempt = vi.fn().mockResolvedValue(true);
    const store = {
      listSubscriptionReconciliationCandidates,
      recordSubscriptionReconciliationAttempt,
      getBillingAccountByStripeCustomer: vi.fn(async () => account),
      getAccountStatus: vi.fn(),
      applyBillingReviewEvent: vi.fn(),
      applySubscriptionEvent: vi.fn(async (event: SubscriptionLifecycleEvent) => {
        applied.push(event);
        return { applied: true, provisioningRequested: true };
      }),
    };
    const stripeFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("stripe-version")).toBe("2025-03-31.basil");
      return Response.json({
        id: "sub_resident",
        customer: "cus_customer",
        status: "unpaid",
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
          { id: "si_resident", price: { id: "price_resident" }, quantity: 1 },
          { id: "si_provider", price: { id: "price_provider" } },
          { id: "si_markup", price: { id: "price_markup" } },
        ] },
        discounts: [],
      });
    });

    await expect(reconcileStripeSubscriptions(env, {
      store: store as never,
      stripeFetch,
      now: NOW,
      limit: 1,
    })).resolves.toEqual({ scanned: 1, reconciled: 1, failed: 0 });

    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      eventType: "customer.subscription.updated",
      eventCreated: Math.floor(NOW / 1_000),
      authoritative: true,
      billingAccountId: account.id,
      stripeSubscriptionId: "sub_resident",
      status: "unpaid",
      reconciledAt: NOW,
    });
    expect(applied[0]?.eventId).toBe(`evt_reconcile_sub_resident_${NOW}`);
    expect(recordSubscriptionReconciliationAttempt).toHaveBeenCalledWith(expect.objectContaining({
      stripeSubscriptionId: "sub_resident",
      billingAccountId: account.id,
      succeeded: true,
    }));
  });

  it("rejects authoritative state that resolves to a different tenant", async () => {
    const otherAccount = { ...account, id: "account_2", tenantKey: "github:organization:999", githubAccountId: "999" };
    const listSubscriptionReconciliationCandidates = vi.fn().mockResolvedValue([candidate()]);
    const recordSubscriptionReconciliationAttempt = vi.fn().mockResolvedValue(true);
    const applySubscriptionEvent = vi.fn(async () => ({ applied: true }));
    const store = {
      listSubscriptionReconciliationCandidates,
      recordSubscriptionReconciliationAttempt,
      getBillingAccountByStripeCustomer: vi.fn(async () => otherAccount),
      getAccountStatus: vi.fn(),
      applyBillingReviewEvent: vi.fn(),
      applySubscriptionEvent,
    };
    const stripeFetch = vi.fn(async () => Response.json({
      id: "sub_resident",
      customer: "cus_customer",
      status: "active",
      current_period_start: 1_999_999_000,
      current_period_end: 2_002_591_000,
      cancel_at_period_end: false,
      metadata: {
        billing_account_id: otherAccount.id,
        tenant_key: otherAccount.tenantKey,
        github_account_id: otherAccount.githubAccountId,
        starting_workflow: "issue-triage",
      },
      items: { data: [
        { id: "si_resident", price: { id: "price_resident" }, quantity: 1 },
        { id: "si_provider", price: { id: "price_provider" } },
        { id: "si_markup", price: { id: "price_markup" } },
      ] },
      discounts: [],
    }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(reconcileStripeSubscriptions(env, {
      store: store as never,
      stripeFetch,
      now: NOW,
    })).resolves.toEqual({ scanned: 1, reconciled: 0, failed: 1 });

    expect(applySubscriptionEvent).not.toHaveBeenCalled();
    expect(recordSubscriptionReconciliationAttempt).toHaveBeenCalledWith(expect.objectContaining({
      billingAccountId: "account_1",
      succeeded: false,
      error: "Stripe subscription reconciliation returned HTTP 500",
    }));
    error.mockRestore();
  });
});
