import { afterEach, describe, expect, it, vi } from "vitest";
import { stripeKey, stripeRequest } from "./stripe";
afterEach(() => vi.unstubAllGlobals());
describe("Stripe payment mode preflight", () => {
  it.each(["sk", "rk"])("accepts matching %s test and live keys", (prefix) => {
    expect(stripeKey({ STRIPE_SECRET_KEY: `${prefix}_test_fake`, STRIPE_LIVE_MODE: "false" })).toBe(`${prefix}_test_fake`);
    expect(stripeKey({ STRIPE_SECRET_KEY: `${prefix}_live_fake`, STRIPE_LIVE_MODE: "true" })).toBe(`${prefix}_live_fake`);
  });
  it.each([
    { STRIPE_SECRET_KEY: "sk_live_fake", STRIPE_LIVE_MODE: "false" },
    { STRIPE_SECRET_KEY: "rk_live_fake", STRIPE_LIVE_MODE: "false" },
    { STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_LIVE_MODE: "true" },
    { STRIPE_SECRET_KEY: "rk_test_fake", STRIPE_LIVE_MODE: "true" },
    { STRIPE_SECRET_KEY: "sk_live_fake", STRIPE_LIVE_MODE: undefined },
    { STRIPE_SECRET_KEY: "pk_test_fake", STRIPE_LIVE_MODE: "false" },
  ])("rejects mode mismatch before making a Stripe request", async (env) => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect((async () => stripeRequest(stripeKey(env), "checkout/sessions", new URLSearchParams({ mode: "payment" })))()).rejects.toThrow("configured mode");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
