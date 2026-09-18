import { describe, expect, it, vi } from "vitest";
import {
  BillingStore,
  pendingMeterExportFromRow,
  provisioningApprovalFromEvent,
  reduceSubscriptionLifecycle,
  reduceProvisioningApproval,
  isProvisioningClaimable,
  resolveCheckoutLease,
  resolveUsageDedupe,
  spendLimitState,
  validateUsageBillingPolicy,
  validatePersonaLogin,
  type CheckoutLease,
  type InferenceUsage,
  type ProvisioningOperation,
  type PendingMeterExportRow,
  type SubscriptionLifecycleEvent,
  type UsageBillingPolicy,
} from "./billing-store";

function usagePolicy(overrides: Partial<UsageBillingPolicy> = {}): UsageBillingPolicy {
  return {
    billingAccountId: "account_1",
    residentId: "resident:account_1",
    markupBasisPoints: 2000,
    acceptedRateCardVersion: "2026-09-01",
    hardSpendLimitMicros: 10_000,
    currentPeriodStart: 900,
    currentPeriodEnd: 2_000,
    ...overrides,
  };
}

function provisioningOperation(overrides: Partial<ProvisioningOperation> = {}): ProvisioningOperation {
  return {
    id: "operation_1",
    billingAccountId: "account_1",
    residentId: "resident:account_1",
    desiredRevision: "issue-triage:v1",
    status: "pending",
    approvalState: "approved",
    approvedBy: "github:user:1",
    approvedAt: 900,
    approvalEvidenceJson: null,
    attemptCount: 0,
    claimedBy: null,
    claimToken: null,
    claimExpiresAt: null,
    evidenceJson: null,
    lastError: null,
    createdAt: 800,
    updatedAt: 900,
    ...overrides,
  };
}

function checkoutLease(overrides: Partial<CheckoutLease> = {}): CheckoutLease {
  return {
    id: "lease_1",
    billingAccountId: "account_1",
    productKey: "resident",
    idempotencyKey: "checkout-account-1-resident-1",
    stripeCheckoutSessionId: null,
    status: "pending",
    expiresAt: 2_000,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function lifecycleEvent(overrides: Partial<SubscriptionLifecycleEvent> = {}): SubscriptionLifecycleEvent {
  return {
    eventId: "evt_200",
    eventType: "customer.subscription.updated",
    eventCreated: 200,
    rawJson: "{}",
    stripeObjectJson: "{}",
    billingAccountId: "account_1",
    stripeSubscriptionId: "sub_1",
    stripeSubscriptionItemId: "si_1",
    auditabilityStripeItemId: null,
    auditabilityEnabled: false,
    pensieveProfile: null,
    status: "active",
    currentPeriodStart: 100,
    currentPeriodEnd: 300,
    cancelAtPeriodEnd: false,
    residentQuantity: 1,
    agentResourceName: "customer-issue-triage",
    ...overrides,
  };
}

function usageEvent(overrides: Partial<InferenceUsage> = {}): InferenceUsage {
  return {
    id: "usage_1",
    billingAccountId: "account_1",
    residentId: "resident:account_1",
    requestId: "provider-request-1",
    requestBodyDigest: "sha256:request-body",
    provider: "example-provider",
    model: "example-model",
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    rateCardVersion: "2026-09-01",
    providerCostMicros: 1234,
    markupBasisPoints: 2000,
    markupMicros: 247,
    occurredAt: 1_000,
    ...overrides,
  };
}

describe("subscription lifecycle ordering", () => {
  it("creates one resident and provisioning operation across duplicate delivery", () => {
    const event = lifecycleEvent();
    const first = reduceSubscriptionLifecycle(null, event);
    expect(first).toMatchObject({
      applies: true,
      createResident: true,
      createProvisioningOperation: true,
    });

    const duplicate = reduceSubscriptionLifecycle(first.state, event);
    expect(duplicate).toMatchObject({
      applies: false,
      createResident: false,
      createProvisioningOperation: false,
    });
  });

  it("ignores delayed lifecycle events without suspending or reprovisioning", () => {
    const active = reduceSubscriptionLifecycle(null, lifecycleEvent());
    const delayed = reduceSubscriptionLifecycle(active.state, lifecycleEvent({
      eventId: "evt_100",
      eventCreated: 100,
      status: "canceled",
    }));
    expect(delayed.applies).toBe(false);
    expect(delayed.createResident).toBe(false);
    expect(delayed.createProvisioningOperation).toBe(false);
    expect(delayed.state).toEqual(active.state);
  });

  it("uses an event ID tie-break for deterministic same-second delivery", () => {
    const first = reduceSubscriptionLifecycle(null, lifecycleEvent({ eventId: "evt_b" }));
    expect(reduceSubscriptionLifecycle(first.state, lifecycleEvent({ eventId: "evt_a" })).applies).toBe(false);
    expect(reduceSubscriptionLifecycle(first.state, lifecycleEvent({ eventId: "evt_c" })).applies).toBe(true);
  });
});

describe("Checkout provisioning consent", () => {
  const checkout = lifecycleEvent({
    eventType: "checkout.session.completed",
    authoritative: true,
    reconciledAt: 200,
    provisioningApprovalActor: "github:user:1",
    provisioningApprovalEvidenceJson: JSON.stringify({ checkoutSessionId: "cs_test_1" }),
  });

  it("accepts approval only from an authoritative completed Checkout event", () => {
    expect(provisioningApprovalFromEvent(checkout)).toEqual({
      actor: "github:user:1",
      evidenceJson: JSON.stringify({ checkoutSessionId: "cs_test_1" }),
    });
    expect(() => provisioningApprovalFromEvent({ ...checkout, authoritative: false }))
      .toThrow("authoritative successful Checkout");
    expect(() => provisioningApprovalFromEvent({ ...checkout, eventType: "customer.subscription.updated" }))
      .toThrow("authoritative successful Checkout");
    expect(() => provisioningApprovalFromEvent({
      ...checkout,
      provisioningApprovalEvidenceJson: undefined,
    })).toThrow("both actor and evidence");
  });

  it("accepts asynchronous Checkout success as payment-backed approval", () => {
    expect(provisioningApprovalFromEvent({
      ...checkout,
      eventType: "checkout.session.async_payment_succeeded",
    })).toMatchObject({ actor: "github:user:1" });
  });

  it("is idempotent and cannot overwrite or downgrade an existing decision", () => {
    const required = { approvalState: "required" as const, actor: null, evidenceJson: null };
    const approved = reduceProvisioningApproval(required, checkout);
    expect(approved).toMatchObject({ approvalState: "approved", actor: "github:user:1" });
    expect(reduceProvisioningApproval(approved, {
      ...checkout,
      eventId: "evt_reordered",
      provisioningApprovalActor: "github:user:attacker",
    })).toBe(approved);
    const rejected = { approvalState: "rejected" as const, actor: "reviewer", evidenceJson: "{}" };
    expect(reduceProvisioningApproval(rejected, checkout)).toBe(rejected);
    expect(reduceProvisioningApproval(approved, lifecycleEvent())).toBe(approved);
  });
});

describe("checkout lease concurrency", () => {
  it("reuses the active lease and its stable idempotency key", () => {
    const existing = checkoutLease();
    const proposed = checkoutLease({ id: "lease_2", idempotencyKey: "different-key" });
    expect(resolveCheckoutLease(existing, false, proposed, 1_500)).toEqual({
      lease: existing,
      reused: true,
    });
  });

  it("replaces an expired lease", () => {
    const proposed = checkoutLease({ id: "lease_2", idempotencyKey: "new-key" });
    expect(resolveCheckoutLease(checkoutLease(), false, proposed, 2_000)).toEqual({
      lease: proposed,
      reused: false,
    });
  });

  it("rejects checkout when a subscription is already active", () => {
    expect(() => resolveCheckoutLease(null, true, checkoutLease(), 1_000))
      .toThrow("active resident subscription");
  });
});

describe("tenant-safe account reads", () => {
  it("looks up the immutable GitHub account ID instead of a mutable login", async () => {
    const first = vi.fn().mockResolvedValue(null);
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    const store = new BillingStore({ prepare } as unknown as D1Database);

    expect(await store.getBillingAccountByGitHubAccountId("123456")).toBeNull();
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("github_account_id = ?"));
    expect(bind).toHaveBeenCalledWith("123456");
  });

  it("binds Checkout Session polling to the account creator", async () => {
    const first = vi.fn().mockResolvedValue(null);
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    const store = new BillingStore({ prepare } as unknown as D1Database);

    expect(await store.getCheckoutStatusBySessionId("cs_test_secret", "github-user-1")).toBeNull();
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("created_by_github_user_id = ?"));
    expect(bind).toHaveBeenCalledWith("cs_test_secret", "github-user-1");
  });
});

describe("provisioning operation claims", () => {
  it("does not claim work before approval", () => {
    expect(isProvisioningClaimable(provisioningOperation({ approvalState: "required" }), 1_000)).toBe(false);
    expect(isProvisioningClaimable(provisioningOperation({ approvalState: "rejected" }), 1_000)).toBe(false);
  });

  it("does not steal an unexpired claim", () => {
    expect(isProvisioningClaimable(provisioningOperation({
      status: "running",
      claimedBy: "worker-a",
      claimToken: "claim-a",
      claimExpiresAt: 1_100,
    }), 1_000)).toBe(false);
  });

  it("allows an expired claim to be recovered but never reclaims terminal work", () => {
    expect(isProvisioningClaimable(provisioningOperation({
      status: "running",
      claimExpiresAt: 1_000,
    }), 1_000)).toBe(true);
    expect(isProvisioningClaimable(provisioningOperation({ status: "succeeded" }), 1_000)).toBe(false);
    expect(isProvisioningClaimable(provisioningOperation({ status: "failed" }), 1_000)).toBe(false);
  });

  it("validates success persona logins and rejects persona changes on failure", async () => {
    expect(validatePersonaLogin("luce-unsup")).toBe("luce-unsup");
    for (const invalid of ["", "-luce", "luce-", "luce--unsup", "luce unsup", "x".repeat(40)]) {
      expect(() => validatePersonaLogin(invalid)).toThrow("valid GitHub login");
    }

    const prepare = vi.fn();
    const store = new BillingStore({ prepare } as unknown as D1Database);
    await expect(store.recordProvisioningResult({
      operationId: "operation_1",
      workerId: "worker_1",
      claimToken: "claim_1",
      succeeded: false,
      evidenceJson: "{}",
      callbackIssuer: "https://token.actions.githubusercontent.com",
      callbackSubject: "repo:example/catalog:ref:refs/heads/main",
      githubAccountId: "123",
      personaLogin: "luce-unsup",
      error: "deployment failed",
      now: 1_000,
    })).rejects.toThrow("only valid for a successful provisioning result");
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe("immutable inference usage dedupe", () => {
  it("dedupes an exact retry by resident and provider request", () => {
    const input = usageEvent();
    expect(resolveUsageDedupe(null, input)).toBe("insert");
    expect(resolveUsageDedupe({ ...input, recordedAt: 1_001 }, input)).toBe("duplicate");
  });

  it("rejects a retry that changes immutable cost data", () => {
    const input = usageEvent();
    expect(() => resolveUsageDedupe(
      { ...input, recordedAt: 1_001 },
      { ...input, providerCostMicros: input.providerCostMicros + 1 },
    )).toThrow("different immutable usage event");
  });

  it("rejects reuse of a request ID for a different request body", () => {
    const input = usageEvent();
    expect(() => resolveUsageDedupe(
      { ...input, recordedAt: 1_001 },
      { ...input, requestBodyDigest: "sha256:different-request-body" },
    )).toThrow("different immutable usage event");
  });
});

describe("trusted inference billing policy", () => {
  it("rejects caller-supplied markup and rate-card policy mismatches", () => {
    const input = usageEvent();
    expect(() => validateUsageBillingPolicy(usagePolicy(), {
      ...input,
      markupBasisPoints: 1000,
      markupMicros: 123,
    })).toThrow("markup basis points");
    expect(() => validateUsageBillingPolicy(usagePolicy(), {
      ...input,
      rateCardVersion: "attacker-rate-card",
    })).toThrow("rate card");
    expect(() => validateUsageBillingPolicy(usagePolicy(), {
      ...input,
      markupMicros: input.markupMicros + 1,
    })).toThrow("markup amount");
  });

  it("rejects usage attributed to a different tenant or resident", () => {
    expect(() => validateUsageBillingPolicy(usagePolicy(), usageEvent({
      billingAccountId: "account_2",
    }))).toThrow("tenant or resident");
    expect(() => validateUsageBillingPolicy(usagePolicy(), usageEvent({
      residentId: "resident:account_2",
    }))).toThrow("tenant or resident");
  });

  it("closes inference at the hard limit and reports no negative remainder", () => {
    expect(spendLimitState(10_000, 9_999)).toEqual({ reached: false, remainingMicros: 1 });
    expect(spendLimitState(10_000, 10_000)).toEqual({ reached: true, remainingMicros: 0 });
    expect(spendLimitState(10_000, 12_000)).toEqual({ reached: true, remainingMicros: 0 });
    expect(spendLimitState(null, 12_000)).toEqual({ reached: false, remainingMicros: null });
  });

  it.each([
    ["provider_cost", 1234],
    ["markup", 247],
  ] as const)("builds the %s Stripe export from immutable ledger values", (meterKind, amountMicros) => {
    const row: PendingMeterExportRow = {
      usage_event_id: "usage_1",
      meter_kind: meterKind,
      stripe_meter_event_id: null,
      status: "pending",
      attempt_count: 0,
      last_error: null,
      next_attempt_at: null,
      exported_at: null,
      first_attempt_at: null,
      last_attempt_at: null,
      retry_deadline_at: null,
      delivery_state: "not_attempted",
      reconciliation_state: "automatic",
      stripe_customer_id: "cus_1",
      occurred_at: 1_000,
      provider_cost_micros: 1234,
      markup_micros: 247,
    };
    expect(pendingMeterExportFromRow(row)).toMatchObject({
      usageEventId: "usage_1",
      meterKind,
      stripeCustomerId: "cus_1",
      eventTimestamp: 1_000,
      amountMicros,
    });
  });
});
