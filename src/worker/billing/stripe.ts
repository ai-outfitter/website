export class StripeRequestError extends Error {
  constructor(readonly paymentIntentId?: string) { super("Payment service unavailable"); }
}
export async function stripeRequest(secret: string, path: string, body?: URLSearchParams, idempotencyKey?: string): Promise<Record<string, any>> {
  if (!secret) throw new Error("Payments are not configured");
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${secret}`,
      ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body, signal: AbortSignal.timeout(6_000), redirect: "error",
  });
  if (!response.ok) {
    let id: unknown;
    try { const value = await response.json() as { error?: { payment_intent?: { id?: unknown } } }; id = value.error?.payment_intent?.id; } catch { /* Keep provider errors out of logs and responses. */ }
    throw new StripeRequestError(typeof id === "string" && /^pi_[A-Za-z0-9]+$/.test(id) ? id : undefined);
  }
  return response.json();
}
