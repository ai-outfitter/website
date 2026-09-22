import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), request: vi.fn(), stripe: vi.fn() }));
vi.mock("../auth", () => ({ session: mocks.session }));
vi.mock("../github", () => ({ github: async () => ({ request: mocks.request }) }));
vi.mock("./stripe", () => ({ stripeRequest: mocks.stripe }));
import { billingRoute } from "./routes";
import { stripeSignature } from "./stripe-webhook";

const checkout = vi.fn(async () => ({ url: "https://checkout.stripe.com/c/pay" }));
const reconcile = vi.fn();
const balance = vi.fn(async () => ({ paidMicros: 10_000_000, currency: "usd" }));
const getByName = vi.fn(() => ({ checkout, reconcile, balance }));
const env = { BETTER_AUTH_URL: "https://example.com", BILLING_ENABLED: "true", STRIPE_LIVE_MODE: "false", STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: "whsec_fake", BILLING_ACCOUNTS: { getByName } } as unknown as Env;
const purchaseId = "00000000-0000-4000-8000-000000000001";
function buy(origin = "https://example.com", cents = 1000) {
  return new Request("https://example.com/api/billing/alice/checkout", { method: "POST", headers: { origin }, body: JSON.stringify({ purchaseId, cents }) });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ user: { githubUserId: 42 } });
  mocks.request.mockResolvedValue({ data: { id: 42, login: "alice", type: "User" } });
});

describe("billing authorization and checkout", () => {
  it("uses the immutable personal ID for purchases", async () => {
    expect((await billingRoute(buy(), env))?.status).toBe(200);
    expect(getByName).toHaveBeenCalledWith("user:42");
    expect(checkout).toHaveBeenCalledWith("user:42", purchaseId, 1000);
  });
  it("rejects anonymous users, other owners, and cross-origin purchases", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await billingRoute(buy(), env))?.status).toBe(401);
    mocks.session.mockResolvedValue({ user: { githubUserId: 100 } });
    expect((await billingRoute(buy(), env))?.status).toBe(403);
    expect((await billingRoute(buy("https://attacker.example"), env))?.status).toBe(403);
    expect(checkout).not.toHaveBeenCalled();
  });
  it("requires active organization ownership rather than repository access", async () => {
    mocks.request.mockResolvedValueOnce({ data: { id: 70, type: "Organization" } }).mockResolvedValueOnce({ data: { state: "active", role: "member" } });
    expect((await billingRoute(buy(), env))?.status).toBe(403);
    mocks.request.mockResolvedValueOnce({ data: { id: 70, type: "Organization" } }).mockResolvedValueOnce({ data: { state: "active", role: "admin" } });
    expect((await billingRoute(buy(), env))?.status).toBe(200);
    expect(getByName).toHaveBeenCalledWith("org:70");
  });
  it("rejects invalid purchase amounts before calling the ledger", async () => {
    expect((await billingRoute(buy("https://example.com", 1.5), env))?.status).toBe(400);
    expect(checkout).not.toHaveBeenCalled();
  });
  it("does not expose purchases while the feature is disabled", async () => {
    expect((await billingRoute(buy(), { ...env, BILLING_ENABLED: "false" }))?.status).toBe(503);
    expect(checkout).not.toHaveBeenCalled();
  });
});

describe("Stripe fulfillment", () => {
  async function delivery(livemode = false, signature = true) {
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ id: "evt_test", created: now, type: "payment_intent.succeeded", livemode, data: { object: { id: "pi_test" } } });
    return new Request("https://example.com/api/webhooks/stripe", { method: "POST", body, headers: { "stripe-signature": signature ? `t=${now},v1=${await stripeSignature("whsec_fake", now, body)}` : "invalid" } });
  }
  it("reconciles current Stripe state even after disabling checkout", async () => {
    mocks.stripe.mockResolvedValue({ metadata: { outfitter_workspace: "org:70" } });
    expect((await billingRoute(await delivery(), { ...env, BILLING_ENABLED: "false" }))?.status).toBe(200);
    expect(reconcile).toHaveBeenCalledWith("org:70", "pi_test");
  });
  it("rejects invalid signatures and live/test mode mismatch", async () => {
    expect((await billingRoute(await delivery(false, false), env))?.status).toBe(400);
    expect((await billingRoute(await delivery(true), env))?.status).toBe(400);
    expect(mocks.stripe).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });
  it("returns a retryable failure rather than acknowledging a lost credit", async () => {
    mocks.stripe.mockResolvedValue({ metadata: { outfitter_workspace: "org:70" } });
    reconcile.mockRejectedValueOnce(new Error("storage unavailable"));
    expect((await billingRoute(await delivery(), env))?.status).toBe(503);
  });
});
