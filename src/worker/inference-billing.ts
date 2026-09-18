import {
  BillingStore,
  billedMarkupMicros,
  type InferenceUsage,
  type PendingMeterExport,
} from "./billing-store";
import { secureEqual } from "./crypto";

const STRIPE_API = "https://api.stripe.com/v1";
const STRIPE_API_VERSION = "2025-03-31.basil";
const MAX_BODY_BYTES = 16_384;
// Stripe only promises meter identifier and idempotency-key deduplication for at
// least 24 hours. Stop one hour early so delayed scheduler work cannot cross it.
export const METER_RETRY_WINDOW_MS = 23 * 60 * 60 * 1_000;

type UsageBody = {
  resident_id?: unknown;
  request_id?: unknown;
  request_body_digest?: unknown;
  provider?: unknown;
  model?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_tokens?: unknown;
  cache_write_tokens?: unknown;
  provider_cost_micros?: unknown;
  occurred_at?: unknown;
};

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function string(value: unknown, name: string, maximum = 255) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new TypeError(`${name} is invalid`);
  return value.trim();
}

function integer(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return Number(value);
}

async function authorized(request: Request, secret: string | undefined) {
  const configured = secret?.trim();
  const header = request.headers.get("authorization");
  if (!configured || !header?.startsWith("Bearer ")) return false;
  return secureEqual(header.slice("Bearer ".length), configured);
}

async function body(request: Request): Promise<UsageBody> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new TypeError("Request is too large");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new TypeError("Request is too large");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Request body must be an object");
  return value as UsageBody;
}

export async function handleInferencePreflight(request: Request, env: Env, store = new BillingStore(env.BILLING_DB)) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!await authorized(request, env.BILLING_SERVICE_TOKEN)) return json({ error: "Unauthorized" }, 401);
  try {
    const value = await body(request);
    const residentId = string(value.resident_id, "resident_id");
    const result = await store.preflightInference(residentId);
    return json(result, result.authorized ? 200 : 403);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
  }
}

export async function handleInferenceUsage(request: Request, env: Env, store = new BillingStore(env.BILLING_DB)) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!await authorized(request, env.BILLING_SERVICE_TOKEN)) return json({ error: "Unauthorized" }, 401);
  try {
    const value = await body(request);
    const residentId = string(value.resident_id, "resident_id");
    const requestId = string(value.request_id, "request_id");
    const digest = string(value.request_body_digest, "request_body_digest");
    if (!/^sha256:[a-f\d]{64}$/i.test(digest)) throw new TypeError("request_body_digest must be a SHA-256 digest");
    const occurredAt = integer(value.occurred_at, "occurred_at");
    const policy = await store.preflightInference(residentId, occurredAt);
    if (!("billingAccountId" in policy)) return json({ error: "Resident has no billable subscription period" }, 409);
    const providerCostMicros = integer(value.provider_cost_micros, "provider_cost_micros");
    const usage: InferenceUsage = {
      id: `usage:${residentId}:${requestId}`,
      billingAccountId: policy.billingAccountId,
      residentId,
      requestId,
      requestBodyDigest: digest.toLowerCase(),
      provider: string(value.provider, "provider", 100),
      model: string(value.model, "model", 200),
      inputTokens: integer(value.input_tokens, "input_tokens"),
      outputTokens: integer(value.output_tokens, "output_tokens"),
      cacheReadTokens: integer(value.cache_read_tokens ?? 0, "cache_read_tokens"),
      cacheWriteTokens: integer(value.cache_write_tokens ?? 0, "cache_write_tokens"),
      rateCardVersion: policy.acceptedRateCardVersion,
      providerCostMicros,
      markupBasisPoints: policy.markupBasisPoints,
      markupMicros: billedMarkupMicros(providerCostMicros, policy.markupBasisPoints),
      occurredAt,
    };
    const result = await store.ingestInferenceUsage(usage);
    return json({ recorded: true, inserted: result.inserted, usageEventId: result.usage.id }, result.inserted ? 201 : 200);
  } catch (error) {
    const conflict = error instanceof Error && /immutable usage event|policy|tenant|period|markup|rate card/i.test(error.message);
    return json({ error: error instanceof Error ? error.message : "Invalid request" }, conflict ? 409 : 400);
  }
}

function basicAuthorization(secret: string) {
  return `Basic ${btoa(`${secret}:`)}`;
}

export async function meterIdentifier(item: Pick<PendingMeterExport, "usageEventId" | "meterKind">) {
  const input = new TextEncoder().encode(`${item.usageEventId}\0${item.meterKind}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `aio:${item.meterKind}:${hex}`;
}

export async function exportPendingMeterEvents(
  env: Env,
  store = new BillingStore(env.BILLING_DB),
  stripeFetch: typeof fetch = fetch,
  now = Date.now(),
) {
  const secret = env.STRIPE_SECRET_KEY?.trim();
  const providerEvent = env.STRIPE_PROVIDER_COST_METER_EVENT_NAME?.trim();
  const markupEvent = env.STRIPE_MARKUP_METER_EVENT_NAME?.trim();
  if (!secret || !providerEvent || !markupEvent) throw new Error("Stripe meter export is not configured");
  await store.expireAmbiguousMeterExports(now);
  const pending = await store.listPendingMeterExports(now, 100);
  let exported = 0;
  let failed = 0;
  let manualReconciliation = 0;
  for (const item of pending) {
    const identifier = await meterIdentifier(item);
    const retryDeadlineAt = item.retryDeadlineAt ?? now + METER_RETRY_WINDOW_MS;
    if (retryDeadlineAt <= now || !await store.beginMeterExportAttempt({
      usageEventId: item.usageEventId,
      meterKind: item.meterKind,
      retryDeadlineAt,
      now,
    })) continue;
    const form = new URLSearchParams({
      event_name: item.meterKind === "provider_cost" ? providerEvent : markupEvent,
      identifier,
      timestamp: String(item.eventTimestamp),
      "payload[stripe_customer_id]": item.stripeCustomerId,
      "payload[value]": String(item.amountMicros),
    });
    try {
      const response = await stripeFetch(`${STRIPE_API}/billing/meter_events`, {
        method: "POST",
        headers: {
          authorization: basicAuthorization(secret),
          "content-type": "application/x-www-form-urlencoded",
          "stripe-version": STRIPE_API_VERSION,
          "idempotency-key": identifier,
        },
        body: form,
      });
      const result: unknown = await response.json().catch(() => null);
      const returnedIdentifier = result && typeof result === "object" && !Array.isArray(result) && "identifier" in result
        ? result.identifier : null;
      if (!response.ok) {
        const error = new Error(`Stripe meter export HTTP ${response.status}`);
        Object.assign(error, { stripeStatus: response.status });
        throw error;
      }
      if (returnedIdentifier !== identifier) throw new Error(`Stripe meter export HTTP ${response.status} returned an unexpected identifier`);
      await store.recordMeterExportResult({ usageEventId: item.usageEventId, meterKind: item.meterKind,
        stripeMeterEventId: identifier, now });
      exported += 1;
    } catch (error) {
      const exponent = Math.min(item.attemptCount, 8);
      const retryAt = now + 30_000 * (2 ** exponent);
      const status = error instanceof Error && "stripeStatus" in error ? Number(error.stripeStatus) : null;
      const rejected = status !== null && status >= 400 && status < 500 && status !== 409 && status !== 429;
      const requiresManualReconciliation = rejected || retryAt >= retryDeadlineAt;
      await store.recordMeterExportResult({ usageEventId: item.usageEventId, meterKind: item.meterKind,
        error: error instanceof Error ? error.message.slice(0, 500) : "Stripe meter export failed",
        retryAt: requiresManualReconciliation ? undefined : retryAt,
        manualReconciliation: requiresManualReconciliation,
        deliveryState: rejected ? "rejected" : "ambiguous",
        now });
      failed += 1;
      if (requiresManualReconciliation) manualReconciliation += 1;
    }
  }
  return { attempted: pending.length, exported, failed, manualReconciliation };
}
