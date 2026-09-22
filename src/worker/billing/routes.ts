import { topupSettings } from "./topups";
import { session } from "../auth";
import { github } from "../github";
import { purchaseCents } from "./ledger";
import { parseStripeEvent, verifyStripeWebhookSignature } from "./stripe-webhook";
import { stripeKey, stripeRequest } from "./stripe";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

export async function limitedText(request: Request, maximum: number) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) { await reader.cancel(); throw new Error("Request too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export async function billingOwner(request: Request, env: Env, login: string) {
  const current = await session(env, request.headers);
  if (!current) throw new Response("Sign in required", { status: 401 });
  const client = await github(env, request);
  const { data: owner } = await client.request("GET /users/{username}", { username: login });
  if (owner.type === "User") {
    if (owner.id !== current.user.githubUserId) throw new Response("Account owner required", { status: 403 });
  } else if (owner.type === "Organization") {
    const { data: membership } = await client.request("GET /user/memberships/orgs/{org}", { org: login });
    if (membership.state !== "active" || membership.role !== "admin") throw new Response("Organization owner required", { status: 403 });
  } else { throw new Response("Unsupported account", { status: 403 }); }
  return `${owner.type === "User" ? "user" : "org"}:${owner.id}`;
}

async function webhook(request: Request, env: Env) {
  if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY) return json({ error: "Payments unavailable" }, 503);
  const raw = await limitedText(request, 256_000);
  if (!await verifyStripeWebhookSignature(env.STRIPE_WEBHOOK_SECRET, raw, request.headers.get("stripe-signature"))) return json({ error: "Invalid signature" }, 400);
  const event = parseStripeEvent(raw);
  if (event.livemode !== (String(env.STRIPE_LIVE_MODE) === "true")) return json({ error: "Payment mode mismatch" }, 400);
  if (!["payment_intent.succeeded", "charge.refunded", "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed"].includes(event.type)) return json({ received: true });
  const object = event.data.object;
  let paymentId: unknown = event.type === "payment_intent.succeeded" ? object.id : object.payment_intent;
  if (!paymentId && typeof object.charge === "string") {
    const charge = await stripeRequest(stripeKey(env), `charges/${encodeURIComponent(object.charge)}`);
    paymentId = charge.payment_intent;
  }
  if (typeof paymentId !== "string" || !/^pi_[A-Za-z0-9]+$/.test(paymentId)) return json({ received: true });
  const payment = await stripeRequest(stripeKey(env), `payment_intents/${paymentId}`);
  const workspace = payment.metadata?.outfitter_workspace;
  if (typeof workspace !== "string" || !/^(user|org):[1-9]\d*$/.test(workspace)) return json({ received: true });
  await env.BILLING_ACCOUNTS.getByName(workspace).reconcile(workspace, paymentId);
  return json({ received: true });
}

export async function billingRoute(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const isWebhook = path === "/api/webhooks/stripe";
  const match = path.match(/^\/api\/billing\/([^/]+)(\/(checkout|limits|topups|topups\/setup|topups\/confirm|topups\/reconcile))?$/);
  if (!isWebhook && !match) return null;
  try {
    // Keep fulfilling purchased credit even when new purchases are disabled.
    if (isWebhook) return request.method === "POST" ? await webhook(request, env) : json({ error: "Method not allowed" }, 405);
    const action = match![3];
    const expected = action === "topups" ? ["GET", "DELETE"] : action?.startsWith("topups/") || action === "checkout" ? ["POST"] : action === "limits" ? ["PUT"] : ["GET"];
    if (!expected.includes(request.method)) return json({ error: "Method not allowed" }, 405);
    if (["POST", "PUT", "DELETE"].includes(request.method) && request.headers.get("origin") !== new URL(env.BETTER_AUTH_URL).origin) return json({ error: "Invalid origin" }, 403);
    if (String(env.BILLING_ENABLED) !== "true" && request.method !== "GET" && !(action === "topups" && request.method === "DELETE") && action !== "topups/reconcile") return json({ error: "Billing is not open yet" }, 503);
    if (path === "/api/billing/accounts" && request.method === "GET") {
      if (!await session(env, request.headers)) return json({ error: "Sign in required" }, 401);
      const client = await github(env, request);
      const { data: viewer } = await client.request("GET /user");
      const accounts = [{ login: viewer.login, type: "User" }];
      for (let page = 1; ; page++) {
        const { data: memberships } = await client.request("GET /user/memberships/orgs", { state: "active", per_page: 100, page });
        for (const membership of memberships) {
          if (membership.role === "admin") accounts.push({ login: membership.organization.login, type: "Organization" });
        }
        if (memberships.length < 100) break;
      }
      return json({ accounts });
    }
    const workspace = await billingOwner(request, env, decodeURIComponent(match![1]));
    const account = env.BILLING_ACCOUNTS.getByName(workspace);
    if (action?.startsWith("topups")) {
      // Disabling and read-only reconciliation remain available after the feature closes.
      if (action === "topups" && request.method === "GET") return json({ featureEnabled: env.TOPUPS_ENABLED === "true", ...await account.topupStatus() });
      if (action === "topups/reconcile") return json(await account.reconcileTopups(workspace));
      const actor = `github:${(await session(env, request.headers))!.user.githubUserId}`;
      if (action === "topups" && request.method === "DELETE") return json(await account.disableTopups(actor));
      if (env.TOPUPS_ENABLED !== "true") return json({ error: "Automatic topups are not open yet" }, 503);
      let input;
      try { input = JSON.parse(await limitedText(request, 4096)); } catch { return json({ error: "Invalid topup settings" }, 400); }
      if (action === "topups/setup") {
        try { topupSettings(input); } catch { return json({ error: "Consent, whole-cent threshold, and $5–$1,000 amount greater than threshold are required" }, 400); }
        return json(await account.setupTopups(workspace, actor, input));
      }
      if (!input || typeof input.session !== "string" || !/^cs_[A-Za-z0-9_]+$/.test(input.session)) return json({ error: "A setup session is required" }, 400);
      return json(await account.confirmTopups(workspace, input.session));
    }
    if (!match![2]) return json({ workspace, ...await account.usage(workspace) });
    if (match![3] === "limits") {
      const input = JSON.parse(await limitedText(request, 4096));
      if (!input || typeof input.enabled !== "boolean" || (input.limitMicros !== null && (!Number.isSafeInteger(input.limitMicros) || input.limitMicros < 0 || input.limitMicros > 1_000_000_000_000))) return json({ error: "Provide an explicit spending limit or null for uncapped usage" }, 400);
      await account.setSpendingPolicy(input.enabled, input.limitMicros);
      return json({ workspace, ...await account.usage(workspace) });
    }
    let input: { purchaseId?: unknown; cents?: unknown };
    try {
      input = JSON.parse(await limitedText(request, 4096));
      if (!input || typeof input.purchaseId !== "string" || !/^[a-f\d-]{36}$/.test(input.purchaseId)) throw new Error();
      purchaseCents(input.cents);
    } catch { return json({ error: "Provide a purchase ID and an amount between $5 and $1,000 in whole cents" }, 400); }
    return json(await account.checkout(workspace, input.purchaseId as string, input.cents as number));
  } catch (error) {
    if (error instanceof Response) return json({ error: await error.text() }, error.status);
    const status = (error as { status?: number }).status;
    if (status === 401 || status === 403 || status === 404) return json({ error: "Account access unavailable" }, 403);
    return json({ error: "Billing temporarily unavailable" }, 503);
  }
}
