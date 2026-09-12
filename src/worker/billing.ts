const CHECKOUT_BODY_LIMIT = 256;
const STRIPE_CHECKOUT_ORIGIN = "https://checkout.stripe.com";

type BillingTier = "individual" | "team";

function json(value: unknown, status: number, headers?: HeadersInit) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

function configuredValue(value: string | undefined) {
  return value?.trim() || null;
}

function priceForTier(env: Env, tier: BillingTier) {
  return configuredValue(tier === "individual" ? env.STRIPE_INDIVIDUAL_PRICE_ID : env.STRIPE_TEAM_PRICE_ID);
}

function checkoutUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.origin === STRIPE_CHECKOUT_ORIGIN ? url : null;
  } catch {
    return null;
  }
}

export async function createCheckoutSession(
  request: Request,
  env: Env,
  stripeFetch: typeof fetch = fetch,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, { allow: "POST" });
  }

  const requestUrl = new URL(request.url);
  if (request.headers.get("origin") !== requestUrl.origin) {
    return json({ error: "Checkout must be started from this site" }, 403);
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/x-www-form-urlencoded") {
    return json({ error: "Checkout requires form data" }, 415);
  }

  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = contentLengthHeader === null ? Number.NaN : Number(contentLengthHeader);
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    return json({ error: "Checkout requires a content length" }, 411);
  }
  if (contentLength > CHECKOUT_BODY_LIMIT) {
    return json({ error: "Checkout request is too large" }, 413);
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > CHECKOUT_BODY_LIMIT) {
    return json({ error: "Checkout request is too large" }, 413);
  }
  const tier = new URLSearchParams(rawBody).get("tier");
  if (tier !== "individual" && tier !== "team") {
    return json({ error: "Choose a valid billing tier" }, 400);
  }

  const secretKey = configuredValue(env.STRIPE_SECRET_KEY);
  const price = priceForTier(env, tier);
  if (!secretKey || !price) {
    return json({ error: "Checkout is not configured" }, 503);
  }

  const successUrl = new URL("/checkout/success/", requestUrl.origin).toString();
  const cancelUrl = new URL("/pricing/", requestUrl.origin).toString();
  const body = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    success_url: successUrl,
    cancel_url: cancelUrl,
    "metadata[tier]": tier,
    "subscription_data[metadata][tier]": tier,
  });

  let stripeResponse: Response;
  try {
    stripeResponse = await stripeFetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${secretKey}:`)}`,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": crypto.randomUUID(),
      },
      body,
    });
  } catch {
    console.error(JSON.stringify({ message: "Stripe checkout session request failed" }));
    return json({ error: "Stripe could not start checkout" }, 502);
  }
  const stripeRequestId = stripeResponse.headers.get("request-id");
  const session: unknown = await stripeResponse.json().catch(() => null);
  const location = checkoutUrl(
    session && typeof session === "object" && !Array.isArray(session) && "url" in session
      ? session.url
      : null,
  );
  if (!stripeResponse.ok || !location) {
    console.error(JSON.stringify({
      message: "Stripe checkout session creation failed",
      status: stripeResponse.status,
      stripeRequestId,
    }));
    return json({ error: "Stripe could not start checkout" }, 502);
  }

  return Response.redirect(location, 303);
}
