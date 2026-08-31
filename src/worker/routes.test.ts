import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
const { default: worker } = await import("../worker");

const env = {
  ASSETS: {
    fetch: async (request: Request) => new URL(request.url).pathname === "/dashboard/"
      ? new Response("<!doctype html><title>Dashboard</title>", { headers: { "content-type": "text/html" } })
      : new Response("not found", { status: 404 }),
  },
} as unknown as Env;

describe("dashboard routes", () => {
  it("returns a normal unauthorized response for signed-out account discovery", async () => {
    const response = await worker.fetch(new Request("https://example.com/api/accounts"), {
      ...env,
      BETTER_AUTH_SECRET: "test-auth-secret-at-least-thirty-two-characters",
      BETTER_AUTH_URL: "https://example.com",
      GITHUB_CLIENT_ID: "client",
      GITHUB_CLIENT_SECRET: "secret",
    } as unknown as Env);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Sign in required" });
  });

  it("serves the one static dashboard route", async () => {
    const response = await worker.fetch(new Request("https://example.com/dashboard/"), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Dashboard");
  });

  it("serves the static dashboard shell at an account-scoped route", async () => {
    const response = await worker.fetch(new Request("https://example.com/dashboard/Unsupervisedcom/"), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Dashboard");
  });

  for (const path of ["/dashboard/install/adversarial-review/", "/dashboard/Unsupervisedcom/workflows/adversarial-review/"]) {
    it(`serves the dashboard shell at ${path}`, async () => {
      const response = await worker.fetch(new Request(`https://example.com${path}`), env);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Dashboard");
    });
  }

  for (const path of [
    "/agents",
    "/install",
    "/organizations",
    "/orgs/acme/workflows/",
    "/orgs/acme/install",
    "/api/scope",
    "/api/organizations",
    "/api/orgs/acme/workflows",
    "/api/agents/bootstrap",
    "/api/agents/plans",
    "/api/agents/apply",
    "/api/accounts/acme/workflows",
    "/api/accounts/acme/repository/resources",
    "/api/accounts/acme/repository",
  ]) {
    it(`does not keep ${path}`, async () => {
      const response = await worker.fetch(new Request(`https://example.com${path}`), env);
      expect(response.status).toBe(404);
    });
  }
});
