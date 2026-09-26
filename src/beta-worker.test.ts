import { describe, expect, it, vi } from "vitest";
vi.mock("./worker/billing/account", () => ({ BillingAccount: class {} }));
vi.mock("./worker/grant", () => ({ GitHubUserGrant: class {} }));
vi.mock("./worker/github", async (original) => ({
  ...await original<typeof import("./worker/github")>(),
  tokenIdentity: async () => ({ id: 42, login: "alice" }),
  tokenAccounts: async () => [{ login: "alice", type: "User", installationId: null, repository: null }],
}));
import worker from "./beta-worker";
const asset = vi.fn(async (_request: Request) => new Response("page"));
const env = { BETTER_AUTH_URL: "https://beta.ai-outfitter.com", STRIPE_LIVE_MODE: "false", BILLING_ENABLED: "true", AGENTS_PLAN_SIGNING_KEY: "test-signing-key", GITHUB_APP_SLUG: "ai-outfitter", BETA_ACCESS_PASSWORD: "test-password", BETA_GITHUB_TOKEN: "fake", ASSETS: { fetch: asset } } as unknown as Env;
const request = (path = "/billing/", password?: string) => new Request(`https://beta.ai-outfitter.com${path}`, { headers: password ? { authorization: `Basic ${btoa(`beta:${password}`)}` } : {} });
describe("beta isolation", () => {
  it("serves dashboard deep links and an authenticated account menu", async () => {
    const page = await worker.fetch(request('/dashboard/alice/', 'test-password'), env);
    expect(page.status).toBe(200);
    expect(new URL(asset.mock.calls.at(-1)![0].url).pathname).toBe('/dashboard/');
    const index = await worker.fetch(request('/api/accounts', 'test-password'), env);
    expect(index.status).toBe(200);
    expect(await index.json()).toMatchObject({ beta: true, activeAccount: { login: 'alice' } });
  });
  it("permits same-origin account selection but blocks GitHub mutations", async () => {
    const headers = { authorization: `Basic ${btoa('beta:test-password')}`, origin: 'https://beta.ai-outfitter.com', 'content-type': 'application/json' };
    const select = () => new Request('https://beta.ai-outfitter.com/api/accounts/active', { method: 'PUT', headers, body: JSON.stringify({ login: 'alice' }) });
    const response = await worker.fetch(select(), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('outfitter_active_account=');
    headers.origin = 'https://elsewhere.example';
    expect((await worker.fetch(select(), env)).status).toBe(403);
    expect((await worker.fetch(new Request('https://beta.ai-outfitter.com/api/accounts/alice/plans/apply', { method: 'POST', headers }), env)).status).toBe(403);
  });
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
    expect((await worker.fetch(request('/api/accounts/alice/plans/apply', 'test-password'), env)).status).toBe(403);
    const response = await worker.fetch(new Request('https://beta.ai-outfitter.com/api/webhooks/stripe', { method: 'POST', body: '{}' }), { ...env, STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake' });
    expect(response.status).toBe(400);
  });
});
