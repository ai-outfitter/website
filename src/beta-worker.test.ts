import { describe, expect, it, vi } from "vitest";
vi.mock("./worker/billing/account", () => ({ BillingAccount: class {} }));
vi.mock("./worker/grant", () => ({ GitHubUserGrant: class {} }));
import worker from "./beta-worker";
const asset = vi.fn(async () => new Response("page"));
const env = { BETTER_AUTH_URL: "https://beta.ai-outfitter.com", STRIPE_LIVE_MODE: "false", BILLING_ENABLED: "true", BETA_ACCESS_PASSWORD: "test-password", BETA_GITHUB_TOKEN: "fake", ASSETS: { fetch: asset } } as unknown as Env;
const request = (path = "/billing/", password?: string) => new Request(`https://beta.ai-outfitter.com${path}`, { headers: password ? { authorization: `Basic ${btoa(`beta:${password}`)}` } : {} });
describe("beta isolation", () => {
  it("protects pages and APIs; authenticated assets cannot be cached publicly", async () => {
    expect((await worker.fetch(request(), env)).status).toBe(401);
    expect((await worker.fetch(request('/api/billing/accounts', 'wrong'), env)).status).toBe(401);
    const page = await worker.fetch(request('/billing/', 'test-password'), env);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('private, no-store');
  });
  it("fails closed with missing credentials, live keys, live mode, or another host", async () => {
    for (const change of [{ BETA_ACCESS_PASSWORD: undefined }, { BETA_GITHUB_TOKEN: undefined }, { STRIPE_SECRET_KEY: 'sk_live_fake' }, { STRIPE_LIVE_MODE: 'true' }]) expect((await worker.fetch(request(), { ...env, ...change } as unknown as Env)).status).toBe(503);
    expect((await worker.fetch(new Request('https://ai-outfitter.com/billing/'), env)).status).toBe(503);
  });
  it("blocks GitHub write routes and OAuth; Stripe still requires its signature", async () => {
    expect((await worker.fetch(request('/api/accounts/alice/plans/apply', 'test-password'), env)).status).toBe(404);
    const response = await worker.fetch(new Request('https://beta.ai-outfitter.com/api/webhooks/stripe', { method: 'POST', body: '{}' }), { ...env, STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake' });
    expect(response.status).toBe(400);
  });
});
