import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ stripe: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ DurableObject: class { constructor(public ctx: DurableObjectState, public env: Env) {} } }));
vi.mock("./stripe", async (original) => ({ ...await original<typeof import("./stripe")>(), stripeRequest: mock.stripe }));
const { BillingAccount } = await import("./account");
let setupId: string, charges: number, payment: Record<string, any>;
beforeEach(() => {
  charges = 0; mock.stripe.mockClear();
  mock.stripe.mockImplementation(async (_secret: string, path: string, body?: URLSearchParams) => {
    if (path === "customers") return { id: "cus_test" };
    if (path === "checkout/sessions") { setupId = body!.get("setup_intent_data[metadata][outfitter_setup]")!; return { id: "cs_test", url: "https://checkout.stripe.com/c/setup" }; }
    if (path.startsWith("checkout/sessions/")) return { mode: "setup", status: "complete", customer: "cus_test", setup_intent: { status: "succeeded", customer: "cus_test", payment_method: "pm_test", metadata: { outfitter_workspace: "user:42", outfitter_setup: setupId } } };
    if (path.startsWith("payment_methods/")) return { customer: "cus_test", type: "card" };
    if (path === "payment_intents") {
      charges++;
      await Promise.resolve();
      payment = { id: "pi_test", status: "succeeded", customer: "cus_test", currency: "usd", amount: Number(body!.get("amount")), amount_received: Number(body!.get("amount")), metadata: { outfitter_workspace: "user:42", outfitter_purchase: body!.get("metadata[outfitter_purchase]") }, latest_charge: { id: "ch_test", disputed: false, amount_refunded: 0 } };
      return payment;
    }
    if (path.startsWith("payment_intents/")) return payment;
    throw Error(path);
  });
});
function fixture(overrides: Partial<Env> = {}, onRead?: () => void) {
  const db = new DatabaseSync(":memory:");
  const sql = { exec(query: string, ...args: never[]) { const rows = db.prepare(query).all(...args); return { toArray: () => rows, one: () => rows[0] }; } } as unknown as SqlStorage;
  const values = new Map(); let gate = Promise.resolve();
  const ctx = { storage: { sql, get: async (key: string) => { onRead?.(); return values.get(key); }, put: async (key: string, value: unknown) => { values.set(key, value); }, transactionSync: <T>(fn: () => T) => { db.exec("BEGIN"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (e) { db.exec("ROLLBACK"); throw e; } } }, blockConcurrencyWhile: <T>(fn: () => Promise<T>) => { const result = gate.then(fn); gate = result.then(() => {}, () => {}); return result; } };
  const env = { TOPUPS_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_fake", BETTER_AUTH_URL: "https://example.com", ...overrides } as Env;
  return new BillingAccount(ctx as unknown as DurableObjectState, env);
}
afterEach(() => vi.useRealTimers());
describe("account automatic topup admission", () => {
  it("serializes concurrent reservations so one refill funds both and webhook replay adds no credit", async () => {
    const account = fixture(); account.setSpendingPolicy(true, 10_000_000);
    await account.setupTopups("user:42", "github:42", { thresholdCents: 500, amountCents: 2000, consent: true });
    await account.confirmTopups("user:42", "cs_test");
    const input = { maximumMicros: 100, userId: "github:42", model: "test", rateVersion: "v1" };
    await Promise.all([account.reserve("user:42", { ...input, id: "a" }), account.reserve("user:42", { ...input, id: "b" })]);
    expect(charges).toBe(1);
    expect(account.usage("user:42")).toMatchObject({ paidMicros: 19_999_800, paidReservedMicros: 200 });
    await account.reconcile("user:42", "pi_test");
    expect(account.usage("user:42").paidMicros).toBe(19_999_800);
    account.settle("a", 50); account.release("b");
    expect(account.usage("user:42")).toMatchObject({ paidMicros: 19_999_950, paidUsedMicros: 50 });
  });
  it("renews free allowance when customer lookup crosses the UTC month", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-30T23:59:59Z"));
    let advance = false;
    const account = fixture({ PARTNER_ALLOWANCES: '{"user:42":1000}' }, () => { if (advance) { advance = false; vi.advanceTimersByTime(2000); } });
    account.setSpendingPolicy(true, 10_000_000);
    await account.setupTopups("user:42", "github:42", { thresholdCents: 500, amountCents: 2000, consent: true });
    await account.confirmTopups("user:42", "cs_test");
    advance = true;
    const result = await account.reserve("user:42", { id: "a", maximumMicros: 100, userId: "github:42", model: "test", rateVersion: "v1" });
    expect(result).toMatchObject({ promotionalMicros: 100, paidMicros: 0 });
    expect(charges).toBe(0);
  });
  it("uses the new free allowance when a paid refill finishes in the next UTC month", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-30T23:59:59Z"));
    const account = fixture({ PARTNER_ALLOWANCES: '{"user:42":1000}' });
    account.setSpendingPolicy(true, 10_000_000);
    await account.setupTopups("user:42", "github:42", { thresholdCents: 500, amountCents: 2000, consent: true });
    await account.confirmTopups("user:42", "cs_test");
    // Exhaust September's grant before requesting paid inference.
    await account.reserve("user:42", { id: "free", maximumMicros: 1000, userId: "github:42", model: "test", rateVersion: "v1" });
    account.settle("free", 1000);
    const original = mock.stripe.getMockImplementation()!;
    mock.stripe.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === "payment_intents") vi.advanceTimersByTime(2000);
      return original(...args);
    });
    const result = await account.reserve("user:42", { id: "a", maximumMicros: 100, userId: "github:42", model: "test", rateVersion: "v1" });
    expect(result).toMatchObject({ promotionalMicros: 100, paidMicros: 0 });
    expect(charges).toBe(1); // Initiated before midnight; its paid credit remains unspent.
    expect(account.usage("user:42")).toMatchObject({ period: "2026-10", paidMicros: 20_000_000, promotionalMicros: 900 });
  });
  it("rejects accidental live keys before setup or checkout can contact Stripe", async () => {
    const account = fixture({ STRIPE_SECRET_KEY: "sk_live_fake" });
    await expect(account.setupTopups("user:42", "github:42", { thresholdCents: 500, amountCents: 2000, consent: true })).rejects.toThrow("configured mode");
    await expect(account.checkout("user:42", "00000000-0000-4000-8000-000000000001", 2000)).rejects.toThrow("configured mode");
    expect(mock.stripe).not.toHaveBeenCalled();
  });
  it("does not charge when the monthly cap cannot admit the request", async () => {
    const account = fixture(); account.setSpendingPolicy(true, 1);
    await account.setupTopups("user:42", "github:42", { thresholdCents: 500, amountCents: 2000, consent: true });
    await account.confirmTopups("user:42", "cs_test");
    await expect(account.reserve("user:42", { id: "a", maximumMicros: 2, userId: "github:42", model: "test", rateVersion: "v1" })).rejects.toThrow();
    expect(charges).toBe(0);
  });
});
