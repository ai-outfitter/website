import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
const { default: worker, managedResources } = await import("../worker");

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

  it("lists only resources recorded by the managed manifest", () => {
    expect(managedResources({
      version: 2,
      catalogSha: "source",
      workflows: {},
      files: {
        "skills/reviewer/SKILL.md": { sha256: "one", workflows: ["review"] },
        "skills/reviewer/reference.md": { sha256: "two", workflows: ["review"] },
        "README.md": { sha256: "three", workflows: ["review"] },
        ".outfitter/website-managed.json": { sha256: "four", workflows: ["review"] },
      },
    })).toEqual([{ path: "skills/reviewer", files: 2 }]);
  });

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
