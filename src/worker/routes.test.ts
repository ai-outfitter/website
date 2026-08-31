import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
const worker = (await import("../worker")).default;

const env = {
  ASSETS: { fetch: async () => new Response("<!doctype html><html><body>static route</body></html>", { headers: { "content-type": "text/html" } }) },
  GITHUB_APP_SLUG: "ai-outfitter",
} as unknown as Env;

describe("organization manager HTML routes", () => {
  for (const path of ["/", "/docs/", "/workflows/", "/404", "/agents", "/organizations", "/orgs/acme/workflows/", "/orgs/acme/install"]) {
    it(`adds sitewide scope control to ${path}`, async () => {
      const response = await worker.fetch(new Request(`https://example.com${path}`), env, {} as ExecutionContext);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain('id="outfitter-scope"');
    });
  }
  it("keeps public static routes available without a session", async () => {
    expect((await worker.fetch(new Request("https://example.com/docs/"), env, {} as ExecutionContext)).status).toBe(200);
    expect((await worker.fetch(new Request("https://example.com/workflows/"), env, {} as ExecutionContext)).status).toBe(200);
  });
});
