import { describe, expect, it } from "vitest";
import { parseStripeEvent, stripeSignature, verifyStripeWebhookSignature } from "./stripe-webhook";

const secret = "whsec_test_only";
const timestamp = 1_800_000_000;
const body = JSON.stringify({
  id: "evt_resident_paid",
  type: "invoice.paid",
  created: timestamp,
  livemode: false,
  data: { object: { id: "in_test", customer: "cus_test" } },
});

async function header(rawBody = body, at = timestamp) {
  return `t=${at},v1=${await stripeSignature(secret, at, rawBody)}`;
}

describe("verifyStripeWebhookSignature", () => {
  it("accepts one matching v1 signature over the exact body", async () => {
    expect(await verifyStripeWebhookSignature(secret, body, await header(), timestamp)).toBe(true);
    expect(await verifyStripeWebhookSignature(secret, body, `v1=${"0".repeat(64)},${await header()}`, timestamp)).toBe(true);
  });

  it("rejects changed bodies, missing signatures, and timestamps outside tolerance", async () => {
    expect(await verifyStripeWebhookSignature(secret, `${body} `, await header(), timestamp)).toBe(false);
    expect(await verifyStripeWebhookSignature(secret, body, null, timestamp)).toBe(false);
    expect(await verifyStripeWebhookSignature(secret, body, `t=${timestamp}`, timestamp)).toBe(false);
    expect(await verifyStripeWebhookSignature(secret, body, await header(body, timestamp - 301), timestamp)).toBe(false);
    expect(await verifyStripeWebhookSignature(secret, body, await header(body, timestamp + 301), timestamp)).toBe(false);
  });
});

describe("parseStripeEvent", () => {
  it("returns the bounded event envelope", () => {
    expect(parseStripeEvent(body)).toEqual({
      id: "evt_resident_paid",
      type: "invoice.paid",
      created: timestamp,
      livemode: false,
      data: { object: { id: "in_test", customer: "cus_test" } },
    });
  });

  it.each([
    "{}",
    JSON.stringify({ id: "not-an-event", type: "invoice.paid", created: 1, livemode: false, data: { object: {} } }),
    JSON.stringify({ id: "evt_test", type: "", created: 1, livemode: false, data: { object: {} } }),
    JSON.stringify({ id: "evt_test", type: "invoice.paid", created: -1, livemode: false, data: { object: {} } }),
    JSON.stringify({ id: "evt_test", type: "invoice.paid", created: 1, livemode: "false", data: { object: {} } }),
  ])("rejects an invalid event envelope", (value) => {
    expect(() => parseStripeEvent(value)).toThrow(/Invalid Stripe event/);
  });
});
