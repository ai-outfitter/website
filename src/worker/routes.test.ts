import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
const worker = (await import("../worker")).default;

const env = {
  ASSETS: {
    fetch: async (request: Request) => new URL(request.url).pathname === "/dashboard/"
      ? new Response("<!doctype html><title>Dashboard</title>", { headers: { "content-type": "text/html" } })
      : new Response("not found", { status: 404 }),
  },
} as unknown as Env;

describe("dashboard routes", () => {
  it("serves the one static dashboard route", async () => {
    const response = await worker.fetch(new Request("https://example.com/dashboard/"), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Dashboard");
  });

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
  ]) {
    it(`does not keep ${path}`, async () => {
      const response = await worker.fetch(new Request(`https://example.com${path}`), env);
      expect(response.status).toBe(404);
    });
  }
});
