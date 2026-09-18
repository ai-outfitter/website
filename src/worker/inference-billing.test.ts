import { describe, expect, it, vi } from "vitest";

import { billedMarkupMicros, type PendingMeterExport } from "./billing-store";
import { METER_RETRY_WINDOW_MS, exportPendingMeterEvents, handleInferencePreflight, handleInferenceUsage } from "./inference-billing";

const env = {
  BILLING_SERVICE_TOKEN: "billing-service-secret",
  STRIPE_SECRET_KEY: "sk_test_example",
  STRIPE_PROVIDER_COST_METER_EVENT_NAME: "provider_cost_microdollars",
  STRIPE_MARKUP_METER_EVENT_NAME: "markup_microdollars",
} as Env;

function request(path: string, value: unknown, token = "billing-service-secret") {
  return new Request(`https://example.com${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

const policy = {
  authorized: true as const,
  reason: "authorized" as const,
  billingAccountId: "billing:github:organization:123",
  residentId: "resident:billing:github:organization:123",
  markupBasisPoints: 2_000,
  acceptedRateCardVersion: "2026-09-17",
  hardSpendLimitMicros: 100_000_000,
  currentPeriodStart: 2_000_000_000,
  currentPeriodEnd: 2_002_592_000,
  periodSpendMicros: 0,
  remainingHardSpendLimitMicros: 100_000_000,
};

describe("trusted inference billing API", () => {
  it("rejects a missing or incorrect service credential before D1", async () => {
    const store = { preflightInference: vi.fn() };
    const response = await handleInferencePreflight(request("/preflight", { resident_id: policy.residentId }, "wrong"), env, store as never);
    expect(response.status).toBe(401);
    expect(store.preflightInference).not.toHaveBeenCalled();
  });

  it("returns tenant-derived inference authorization and remaining spend", async () => {
    const store = { preflightInference: vi.fn(async () => policy) };
    const response = await handleInferencePreflight(request("/preflight", { resident_id: policy.residentId }), env, store as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(policy);
  });

  it("derives account, rate card, and markup instead of accepting billing policy from the caller", async () => {
    const ingestInferenceUsage = vi.fn(async (usage) => ({ inserted: true, usage }));
    const store = { preflightInference: vi.fn(async () => policy), ingestInferenceUsage };
    const response = await handleInferenceUsage(request("/usage", {
      resident_id: policy.residentId,
      request_id: "provider-request-1",
      request_body_digest: `sha256:${"a".repeat(64)}`,
      provider: "openai",
      model: "gpt-example",
      input_tokens: 100,
      output_tokens: 50,
      provider_cost_micros: 1_001,
      occurred_at: 2_000_000_100,
      billing_account_id: "attacker-account",
      markup_basis_points: 0,
      rate_card_version: "attacker-rate",
    }), env, store as never);
    expect(response.status).toBe(201);
    expect(ingestInferenceUsage).toHaveBeenCalledWith(expect.objectContaining({
      billingAccountId: policy.billingAccountId,
      rateCardVersion: policy.acceptedRateCardVersion,
      markupBasisPoints: 2_000,
      markupMicros: billedMarkupMicros(1_001, 2_000),
    }));
  });

  it("records actual usage even when a concurrent request has just reached the cap", async () => {
    const capped = { ...policy, authorized: false as const, reason: "spend_limit_reached" as const,
      periodSpendMicros: 100_000_000, remainingHardSpendLimitMicros: 0 };
    const ingestInferenceUsage = vi.fn(async (usage) => ({ inserted: true, usage }));
    const store = { preflightInference: vi.fn(async () => capped), ingestInferenceUsage };
    const response = await handleInferenceUsage(request("/usage", {
      resident_id: policy.residentId,
      request_id: "already-completed-request",
      request_body_digest: `sha256:${"b".repeat(64)}`,
      provider: "openai", model: "gpt-example", input_tokens: 1, output_tokens: 1,
      provider_cost_micros: 10, occurred_at: 2_000_000_200,
    }), env, store as never);
    expect(response.status).toBe(201);
    expect(ingestInferenceUsage).toHaveBeenCalledOnce();
  });
});

describe("Stripe meter export", () => {
  it("exports provider cost and markup as separate idempotent meter events", async () => {
    const pending: PendingMeterExport[] = [
      { usageEventId: "usage_1", meterKind: "provider_cost", stripeMeterEventId: null, status: "pending",
        attemptCount: 0, lastError: null, nextAttemptAt: null, exportedAt: null,
        firstAttemptAt: null, lastAttemptAt: null, retryDeadlineAt: null,
        deliveryState: "not_attempted", reconciliationState: "automatic",
        stripeCustomerId: "cus_1", eventTimestamp: 2_000_000_100, amountMicros: 1_000 },
      { usageEventId: "usage_1", meterKind: "markup", stripeMeterEventId: null, status: "pending",
        attemptCount: 0, lastError: null, nextAttemptAt: null, exportedAt: null,
        firstAttemptAt: null, lastAttemptAt: null, retryDeadlineAt: null,
        deliveryState: "not_attempted", reconciliationState: "automatic",
        stripeCustomerId: "cus_1", eventTimestamp: 2_000_000_100, amountMicros: 200 },
    ];
    const recordMeterExportResult = vi.fn(async () => undefined);
    const store = { expireAmbiguousMeterExports: vi.fn(async () => 0), listPendingMeterExports: vi.fn(async () => pending),
      beginMeterExportAttempt: vi.fn(async () => true), recordMeterExportResult };
    const stripeFetch = vi.fn(async (_input, init?: RequestInit) => {
      const form = init?.body as URLSearchParams;
      return Response.json({ identifier: form.get("identifier") });
    });
    const result = await exportPendingMeterEvents(env, store as never, stripeFetch as never, 2_000_000_300_000);
    expect(result).toEqual({ attempted: 2, exported: 2, failed: 0, manualReconciliation: 0 });
    expect(stripeFetch).toHaveBeenCalledTimes(2);
    const forms = stripeFetch.mock.calls.map(([, init]) => init?.body as URLSearchParams);
    expect(forms.map((form) => [form.get("event_name"), form.get("payload[value]")])).toEqual([
      ["provider_cost_microdollars", "1000"], ["markup_microdollars", "200"],
    ]);
    expect(stripeFetch.mock.calls.map(([, init]) => (init?.headers as Record<string, string>)["idempotency-key"]))
      .toEqual(["ai-outfitter:usage_1:provider_cost", "ai-outfitter:usage_1:markup"]);
    expect(store.beginMeterExportAttempt).toHaveBeenNthCalledWith(1, {
      usageEventId: "usage_1", meterKind: "provider_cost",
      retryDeadlineAt: 2_000_000_300_000 + METER_RETRY_WINDOW_MS, now: 2_000_000_300_000,
    });
    expect(recordMeterExportResult).toHaveBeenCalledTimes(2);
  });

  it("records a bounded retry instead of dropping a failed export", async () => {
    const item: PendingMeterExport = { usageEventId: "usage_2", meterKind: "provider_cost",
      stripeMeterEventId: null, status: "failed", attemptCount: 2, lastError: "old", nextAttemptAt: 1, exportedAt: null,
      firstAttemptAt: 100, lastAttemptAt: 500, retryDeadlineAt: 100 + METER_RETRY_WINDOW_MS,
      deliveryState: "ambiguous", reconciliationState: "automatic",
      stripeCustomerId: "cus_2", eventTimestamp: 2_000_000_100, amountMicros: 500 };
    const recordMeterExportResult = vi.fn(async () => undefined);
    const store = { expireAmbiguousMeterExports: vi.fn(async () => 0), listPendingMeterExports: vi.fn(async () => [item]),
      beginMeterExportAttempt: vi.fn(async () => true), recordMeterExportResult };
    const result = await exportPendingMeterEvents(env, store as never,
      vi.fn(async () => Response.json({ error: {} }, { status: 503 })), 1_000);
    expect(result).toEqual({ attempted: 1, exported: 0, failed: 1, manualReconciliation: 0 });
    expect(recordMeterExportResult).toHaveBeenCalledWith(expect.objectContaining({
      usageEventId: "usage_2", meterKind: "provider_cost", retryAt: 121_000,
    }));
  });

  it("stops automatic retries before Stripe's 24-hour deduplication window expires", async () => {
    const now = 2_000_000_000_000;
    const item: PendingMeterExport = { usageEventId: "usage_3", meterKind: "provider_cost",
      stripeMeterEventId: null, status: "failed", attemptCount: 8, lastError: "timeout", nextAttemptAt: now,
      exportedAt: null,
      firstAttemptAt: now - METER_RETRY_WINDOW_MS + 1_000, lastAttemptAt: now - 1_000,
      retryDeadlineAt: now + 1_000, deliveryState: "ambiguous", reconciliationState: "automatic",
      stripeCustomerId: "cus_3", eventTimestamp: 2_000_000_100, amountMicros: 500 };
    const recordMeterExportResult = vi.fn(async () => undefined);
    const store = { expireAmbiguousMeterExports: vi.fn(async () => 0), listPendingMeterExports: vi.fn(async () => [item]),
      beginMeterExportAttempt: vi.fn(async () => true), recordMeterExportResult };
    const result = await exportPendingMeterEvents(env, store as never,
      vi.fn(async () => { throw new Error("connection reset after write"); }), now);
    expect(result.manualReconciliation).toBe(1);
    expect(recordMeterExportResult).toHaveBeenCalledWith(expect.objectContaining({
      manualReconciliation: true, retryAt: undefined, deliveryState: "ambiguous",
    }));
  });

  it("sends deterministic Stripe rejections to manual reconciliation without retrying", async () => {
    const now = 2_000_000_000_000;
    const item: PendingMeterExport = { usageEventId: "usage_4", meterKind: "markup",
      stripeMeterEventId: null, status: "pending", attemptCount: 0, lastError: null, nextAttemptAt: null,
      exportedAt: null,
      firstAttemptAt: null, lastAttemptAt: null, retryDeadlineAt: null,
      deliveryState: "not_attempted", reconciliationState: "automatic",
      stripeCustomerId: "cus_4", eventTimestamp: 2_000_000_100, amountMicros: 100 };
    const recordMeterExportResult = vi.fn(async () => undefined);
    const store = { expireAmbiguousMeterExports: vi.fn(async () => 0), listPendingMeterExports: vi.fn(async () => [item]),
      beginMeterExportAttempt: vi.fn(async () => true), recordMeterExportResult };
    await exportPendingMeterEvents(env, store as never,
      vi.fn(async () => Response.json({ error: {} }, { status: 400 })), now);
    expect(recordMeterExportResult).toHaveBeenCalledWith(expect.objectContaining({
      manualReconciliation: true, deliveryState: "rejected", retryAt: undefined,
    }));
  });
});
