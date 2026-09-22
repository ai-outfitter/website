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
  if (!response.ok) throw new Error("Payment service unavailable");
  return response.json();
}
