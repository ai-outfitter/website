import { secureEqual } from "../crypto";

const DEFAULT_TOLERANCE_SECONDS = 300;

type StripeObject = Record<string, unknown>;

export type StripeEvent = {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: { object: StripeObject };
};

function signatureParts(header: string) {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t" && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === "v1" && /^[a-f\d]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  return { timestamp, signatures };
}

function hex(value: ArrayBuffer) {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function stripeSignature(
  secret: string,
  timestamp: number,
  rawBody: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  ));
}

/** Verify Stripe's signature against the exact, unparsed request body. */
export async function verifyStripeWebhookSignature(
  secret: string,
  rawBody: string,
  header: string | null,
  nowSeconds = Math.floor(Date.now() / 1_000),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
) {
  if (!secret || !header) return false;
  const { timestamp, signatures } = signatureParts(header);
  if (!Number.isSafeInteger(timestamp) || timestamp === null || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = await stripeSignature(secret, timestamp, rawBody);
  const matches = await Promise.all(signatures.map((signature) => secureEqual(signature, expected)));
  return matches.some(Boolean);
}

function record(value: unknown): value is StripeObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function parseStripeEvent(rawBody: string): StripeEvent {
  const value: unknown = JSON.parse(rawBody);
  if (!record(value) || typeof value.id !== "string" || !value.id.startsWith("evt_")) {
    throw new Error("Invalid Stripe event ID");
  }
  if (typeof value.type !== "string" || !value.type) throw new Error("Invalid Stripe event type");
  if (!Number.isSafeInteger(value.created) || Number(value.created) < 0) throw new Error("Invalid Stripe event timestamp");
  if (typeof value.livemode !== "boolean") throw new Error("Invalid Stripe event mode");
  if (!record(value.data) || !record(value.data.object)) throw new Error("Invalid Stripe event data");
  return {
    id: value.id,
    type: value.type,
    created: Number(value.created),
    livemode: value.livemode,
    data: { object: value.data.object },
  };
}
