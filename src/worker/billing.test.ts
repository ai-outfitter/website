import { describe, expect, it, vi } from "vitest";
import { createCheckoutSession } from "./billing";

const billingEnv = {
  STRIPE_SECRET_KEY: "sk_test_example",
  STRIPE_INDIVIDUAL_PRICE_ID: "price_individual",
  STRIPE_TEAM_PRICE_ID: "price_team",
} as unknown as Env;

function checkoutRequest(tier = "individual", overrides: RequestInit = {}) {
  const body = new URLSearchParams({ tier }).toString();
  return new Request("https://ai-outfitter.com/api/billing/checkout", {
    method: "POST",
    body,
    headers: {
      origin: "https://ai-outfitter.com",
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(new TextEncoder().encode(body).byteLength),
    },
    ...overrides,
  });
}

function stripeResponse(url: unknown = "https://checkout.stripe.com/c/pay/test") {
  return new Response(JSON.stringify({ url }), {
    headers: { "content-type": "application/json", "request-id": "req_test" },
  });
}

describe("createCheckoutSession", () => {
  it.each([
    ["individual", "price_individual"],
    ["team", "price_team"],
  ])("creates a monthly %s checkout from the server-side price", async (tier, price) => {
    let call: [URL | RequestInfo, RequestInit | undefined] | null = null;
    const stripeFetch: typeof fetch = async (input, init) => {
      call = [input, init];
      return stripeResponse();
    };
    const response = await createCheckoutSession(checkoutRequest(tier), billingEnv, stripeFetch);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://checkout.stripe.com/c/pay/test");
    expect(call).not.toBeNull();
    const [url, init] = call!;
    expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual(expect.objectContaining({
      authorization: `Basic ${btoa("sk_test_example:")}`,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": expect.any(String),
    }));
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("mode")).toBe("subscription");
    expect(body.get("line_items[0][price]")).toBe(price);
    expect(body.get("line_items[0][quantity]")).toBe("1");
    expect(body.get("metadata[tier]")).toBe(tier);
    expect(body.get("subscription_data[metadata][tier]")).toBe(tier);
    expect(body.get("success_url")).toBe("https://ai-outfitter.com/checkout/success/");
    expect(body.get("cancel_url")).toBe("https://ai-outfitter.com/pricing/");
  });

  it("rejects cross-origin checkout requests", async () => {
    const stripeFetch = vi.fn();
    const response = await createCheckoutSession(checkoutRequest("individual", {
      headers: {
        origin: "https://example.com",
        "content-type": "application/x-www-form-urlencoded",
        "content-length": "15",
      },
    }), billingEnv, stripeFetch);
    expect(response.status).toBe(403);
    expect(stripeFetch).not.toHaveBeenCalled();
  });

  it("rejects requests without form content", async () => {
    const stripeFetch = vi.fn();
    const response = await createCheckoutSession(checkoutRequest("individual", {
      headers: {
        origin: "https://ai-outfitter.com",
        "content-type": "application/json",
        "content-length": "2",
      },
    }), billingEnv, stripeFetch);
    expect(response.status).toBe(415);
    expect(stripeFetch).not.toHaveBeenCalled();
  });

  it("rejects requests without a content length", async () => {
    const stripeFetch = vi.fn();
    const response = await createCheckoutSession(checkoutRequest("individual", {
      headers: {
        origin: "https://ai-outfitter.com",
        "content-type": "application/x-www-form-urlencoded",
      },
    }), billingEnv, stripeFetch);
    expect(response.status).toBe(411);
    expect(stripeFetch).not.toHaveBeenCalled();
  });

  it("rejects a declared body larger than the checkout limit", async () => {
    const stripeFetch = vi.fn();
    const response = await createCheckoutSession(checkoutRequest("individual", {
      headers: {
        origin: "https://ai-outfitter.com",
        "content-type": "application/x-www-form-urlencoded",
        "content-length": "257",
      },
    }), billingEnv, stripeFetch);
    expect(response.status).toBe(413);
    expect(stripeFetch).not.toHaveBeenCalled();
  });

  it("rejects an actual body larger than the checkout limit", async () => {
    const stripeFetch = vi.fn();
    const body = `tier=individual&padding=${"x".repeat(257)}`;
    const response = await createCheckoutSession(checkoutRequest("individual", {
      body,
      headers: {
        origin: "https://ai-outfitter.com",
        "content-type": "application/x-www-form-urlencoded",
        "content-length": "15",
      },
    }), billingEnv, stripeFetch);
    expect(response.status).toBe(413);
    expect(stripeFetch).not.toHaveBeenCalled();
  });

  it("rejects arbitrary client-selected prices", async () => {
    const response = await createCheckoutSession(checkoutRequest("price_attacker"), billingEnv, vi.fn());
    expect(response.status).toBe(400);
  });

  it("fails closed when Stripe is not configured", async () => {
    const response = await createCheckoutSession(checkoutRequest(), {} as Env, vi.fn());
    expect(response.status).toBe(503);
  });

  it("does not redirect to an unexpected Stripe response URL", async () => {
    const stripeFetch: typeof fetch = async () => stripeResponse("https://example.com/redirect");
    const response = await createCheckoutSession(
      checkoutRequest(),
      billingEnv,
      stripeFetch,
    );
    expect(response.status).toBe(502);
  });

  it("does not expose Stripe error details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stripeFetch: typeof fetch = async () => new Response(JSON.stringify({ error: { message: "sensitive detail" } }), {
      status: 400,
      headers: { "content-type": "application/json", "request-id": "req_failure" },
    });
    const response = await createCheckoutSession(
      checkoutRequest(),
      billingEnv,
      stripeFetch,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Stripe could not start checkout" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("req_failure"));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("sensitive detail"));
    log.mockRestore();
  });

  it("returns a generic error when Stripe cannot be reached", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stripeFetch: typeof fetch = async () => {
      throw new Error("network detail");
    };
    const response = await createCheckoutSession(checkoutRequest(), billingEnv, stripeFetch);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Stripe could not start checkout" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Stripe checkout session request failed"));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("network detail"));
    log.mockRestore();
  });
});
