import { timingSafeEqual } from "node:crypto";
import { Octokit } from "@octokit/core";
import { billingRoute, type BillingIdentity } from "./worker/billing/routes";
export { BillingAccount } from "./worker/billing/account";
export { GitHubUserGrant } from "./worker/grant";

const json = (error: string, status: number) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

async function authorized(request: Request, password: string) {
  const supplied = request.headers.get("authorization") ?? "";
  const expected = `Basic ${btoa(`beta:${password}`)}`;
  const digest = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [left, right] = await Promise.all([digest(supplied), digest(expected)]);
  return timingSafeEqual(new Uint8Array(left), new Uint8Array(right));
}

// This entry point is deployed only to beta, never imported by the production Worker.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== "https://beta.ai-outfitter.com" || env.BETTER_AUTH_URL !== url.origin || String(env.STRIPE_LIVE_MODE) !== "false") return json("Invalid beta configuration", 503);
    if (env.STRIPE_SECRET_KEY && !/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY)) return json("Sandbox Stripe key required", 503);
    // Stripe authenticates through its signature; it cannot use browser Basic auth.
    if (url.pathname === "/api/webhooks/stripe") return (await billingRoute(request, env))!;
    if (!env.BETA_ACCESS_PASSWORD || !env.BETA_GITHUB_TOKEN) return json("Beta credentials unavailable", 503);
    if (!await authorized(request, env.BETA_ACCESS_PASSWORD)) return new Response("Beta access required", { status: 401, headers: { "www-authenticate": 'Basic realm="Outfitter sandbox", charset="UTF-8"', "cache-control": "no-store" } });
    const identity: BillingIdentity = async () => {
      const client = new Octokit({ auth: env.BETA_GITHUB_TOKEN });
      client.hook.before("request", (options) => {
        if (options.method !== "GET") throw new Error("Beta GitHub access is read-only");
      });
      const { data: viewer } = await client.request("GET /user");
      return { githubUserId: Number(viewer.id), client };
    };
    const billing = await billingRoute(request, env, identity);
    if (billing) return billing;
    if (url.pathname.startsWith("/api/")) return json("This beta stages prepaid billing only", 404);
    if (!["GET", "HEAD"].includes(request.method)) return json("Method not allowed", 405);
    if (url.pathname === "/") return Response.redirect(`${url.origin}/billing/`, 302);
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("cache-control", "private, no-store");
    headers.set("x-robots-tag", "noindex, nofollow");
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<Env>;
