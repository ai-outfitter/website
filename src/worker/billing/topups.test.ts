import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomaticTopups } from "./topups";
import { CreditLedger } from "./ledger";
import { UsageBudget } from "./budget";
import { PartnerCredit } from "./partner-credit";
import { StripeRequestError } from "./stripe";
const workspace = "user:42";
const settings = { thresholdCents: 500, amountCents: 2000, consent: true as const };
function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql = { exec(query: string, ...args: never[]) { const rows = db.prepare(query).all(...args); return { toArray: () => rows, one: () => rows[0] }; } } as unknown as SqlStorage;
  const transaction = <T>(fn: () => T) => { db.exec("BEGIN"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (e) { db.exec("ROLLBACK"); throw e; } };
  const ledger = new CreditLedger(sql, transaction); new PartnerCredit(sql, transaction); const budget = new UsageBudget(sql, transaction);
  budget.policy(true, 30_000_000);
  let setupId = ""; let outcome = "succeeded"; let networkError = false; let checkoutStatus = "complete"; let customer = "cus_test";
  const payments = new Map<string, Record<string, any>>(); let requests = 0;
  const stripe = vi.fn(async (path: string, body?: URLSearchParams, key?: string) => {
    if (path === "checkout/sessions") { setupId = body!.get("setup_intent_data[metadata][outfitter_setup]")!; return { id: "cs_test", url: "https://checkout.stripe.com/c/test" }; }
    if (path.startsWith("checkout/sessions/")) return { mode: "setup", status: checkoutStatus, customer, setup_intent: { status: "succeeded", customer, payment_method: "pm_test", metadata: { outfitter_workspace: workspace, outfitter_setup: setupId } } };
    if (path.startsWith("payment_methods/")) return { customer, type: "card" };
    if (path === "payment_intents") {
      requests++;
      let payment = payments.get(key!);
      if (!payment) {
        payment = { id: `pi_test${payments.size}`, customer: body!.get("customer"), currency: "usd", amount: Number(body!.get("amount")), status: outcome, metadata: { outfitter_workspace: body!.get("metadata[outfitter_workspace]"), outfitter_purchase: body!.get("metadata[outfitter_purchase]") } };
        payments.set(key!, payment);
      }
      if (networkError) throw new Error("socket closed after payment");
      if (outcome === "requires_action") throw new StripeRequestError(payment.id);
      return payment;
    }
    if (path.startsWith("payment_intents?")) return { data: [...payments.values()], has_more: false };
    if (path.startsWith("payment_intents/")) {
      const payment = [...payments.values()].find((item) => path.includes(item.id));
      if (!payment) throw Error("missing");
      if (path.endsWith("/cancel")) payment.status = "canceled";
      return payment;
    }
    throw Error(path);
  });
  const reconcile = vi.fn(async (_workspace: string, paymentId: string) => {
    const payment = [...payments.values()].find((item) => item.id === paymentId)!;
    ledger.reconcile({ id: payment.metadata.outfitter_purchase, payment: paymentId, customer: payment.customer, receivedCents: payment.amount, refundedCents: 0, disputed: false });
  });
  const topups = new AutomaticTopups(sql, stripe, ledger, reconcile);
  return { db, sql, ledger, budget, stripe, reconcile, topups, payments, requests: () => requests,
    setOutcome: (value: string) => { outcome = value; }, setNetworkError: (value: boolean) => { networkError = value; },
    setCheckoutStatus: (value: string) => { checkoutStatus = value; }, setCustomer: (value: string) => { customer = value; },
    enable: async () => { await topups.setup(workspace, "cus_test", "github:42", settings, "https://example.com"); await topups.finishSetup(workspace, "cus_test", "cs_test"); },
  };
}
afterEach(() => vi.useRealTimers());
describe("automatic credit purchases", () => {
  it("requires explicit consent and server-verified setup for the same customer", async () => {
    const f = fixture();
    await expect(f.topups.setup(workspace, "cus_test", "github:42", { ...settings, consent: false } as never, "https://example.com")).rejects.toThrow();
    await f.topups.setup(workspace, "cus_test", "github:42", settings, "https://example.com");
    expect(f.topups.status().enabled).toBe(false);
    f.setCheckoutStatus("open"); await expect(f.topups.finishSetup(workspace, "cus_test", "cs_test")).rejects.toThrow();
    f.setCheckoutStatus("complete"); f.setCustomer("cus_other"); await expect(f.topups.finishSetup(workspace, "cus_test", "cs_test")).rejects.toThrow();
    f.setCustomer("cus_test"); await f.topups.finishSetup(workspace, "cus_test", "cs_test");
    expect(f.topups.status().enabled).toBe(true);
    expect(f.db.prepare("SELECT action FROM topup_consents").all()).toEqual([{ action: "authorize" }]);
  });
  it("does not charge without opt-in, paid usage, feature, or enough monthly capacity", async () => {
    const f = fixture();
    await f.topups.maybeRefill(workspace, "cus_test", f.budget.summary(), 100, true);
    await f.enable();
    await f.topups.maybeRefill(workspace, "cus_test", f.budget.summary(), 100, false);
    f.budget.policy(false, null); await f.topups.maybeRefill(workspace, "cus_test", f.budget.summary(), 100, true);
    f.budget.policy(true, 99); await f.topups.maybeRefill(workspace, "cus_test", f.budget.summary(), 100, true);
    f.budget.policy(true, null); await f.topups.maybeRefill(workspace, "cus_test", f.budget.summary(), 0, true);
    expect(f.requests()).toBe(0);
  });
  it("credits success once; the monthly usage limit does not reduce the authorized purchase", async () => {
    const f = fixture(); await f.enable(); f.budget.policy(true, 100);
    await f.topups.maybeRefill(workspace, "cus_test", f.budget.summary(), 100, true);
    expect(f.ledger.balance().paidMicros).toBe(20_000_000);
    await f.topups.maybeRefill(workspace, "cus_test", f.budget.summary(), 100, true);
    expect(f.requests()).toBe(1);
    expect(f.budget.reserve({ id: "r", maximumMicros: 100, userId: "github:42", model: "test", rateVersion: "v1" }).paidMicros).toBe(100);
    expect(() => f.budget.reserve({ id: "r2", maximumMicros: 1, userId: "github:42", model: "test", rateVersion: "v1" })).toThrow("paid_limit_reached");
  });
  it("retains unknown outcomes and reconciles a succeeded charge after a lost response", async () => {
    const f = fixture(); await f.enable(); f.setNetworkError(true);
    await f.topups.maybeRefill(workspace, "cus_test", f.budget.summary(), 100, true);
    expect(f.ledger.balance().paidMicros).toBe(0); expect(f.topups.status().pending).toBe(true);
    await f.topups.refreshPending(workspace, false);
    expect(f.ledger.balance().paidMicros).toBe(20_000_000); expect(f.requests()).toBe(1);
    await f.topups.refreshPending(workspace, false); expect(f.reconcile).toHaveBeenCalledTimes(1);
  });
  it("retains the same idempotency key across retries and refuses replay after 23h", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.enable(); f.setNetworkError(true);
    await f.topups.maybeRefill(workspace, "cus_test", f.budget.summary(), 100, true);
    await f.topups.maybeRefill(workspace, "cus_test", f.budget.summary(), 100, true);
    expect(f.requests()).toBe(2); expect(f.payments.size).toBe(1);
    vi.advanceTimersByTime(24 * 3600_000);
    await f.topups.maybeRefill(workspace, "cus_test", f.budget.summary(), 100, true);
    expect(f.requests()).toBe(2); expect(f.ledger.balance().paidMicros).toBe(20_000_000);
  });
  it.each(["requires_action", "requires_payment_method"])("pauses %s and cancels it before another setup", async (status) => {
    const f = fixture(); await f.enable(); f.setOutcome(status);
    await f.topups.maybeRefill(workspace, "cus_test", f.budget.summary(), 100, true);
    expect(f.topups.status()).toMatchObject({ enabled: false, pending: false, status: status === "requires_action" ? "authentication_required" : "payment_failed" });
    expect(f.ledger.balance().paidMicros).toBe(0);
    expect([...f.payments.values()][0].status).toBe("canceled");
    await f.topups.maybeRefill(workspace, "cus_test", f.budget.summary(), 100, true); expect(f.requests()).toBe(1);
    await f.enable(); expect(f.topups.status().enabled).toBe(true);
  });
  it("revocation forbids future submissions but preserves already-succeeded credit", async () => {
    const f = fixture(); await f.enable(); f.setNetworkError(true);
    await f.topups.maybeRefill(workspace, "cus_test", f.budget.summary(), 100, true);
    f.topups.disable("github:42");
    await f.topups.maybeRefill(workspace, "cus_test", f.budget.summary(), 100, true);
    expect(f.requests()).toBe(1); expect(f.ledger.balance().paidMicros).toBe(20_000_000); expect(f.topups.status().enabled).toBe(false);
    expect(f.db.prepare("SELECT action FROM topup_consents ORDER BY id").all()).toEqual([{ action: "authorize" }, { action: "revoke" }]);
  });
  it("does not credit processing payments or replace an unresolved attempt", async () => {
    const f = fixture(); await f.enable(); f.setOutcome("processing");
    await f.topups.maybeRefill(workspace, "cus_test", f.budget.summary(), 100, true);
    await f.topups.maybeRefill(workspace, "cus_test", f.budget.summary(), 100, true);
    expect(f.requests()).toBe(1); expect(f.ledger.balance().paidMicros).toBe(0);
    await expect(f.topups.setup(workspace, "cus_test", "github:42", settings, "https://example.com")).rejects.toThrow("reconciliation");
  });
  it("does not purchase when one topup cannot cover admission or account has reversal debt", async () => {
    const f = fixture(); await f.enable();
    await f.topups.maybeRefill(workspace, "cus_test", f.budget.summary(), 25_000_000, true);
    await f.topups.maybeRefill(workspace, "cus_test", { ...f.budget.summary(), paidMicros: -1 }, 100, true);
    expect(f.requests()).toBe(0);
  });
});
