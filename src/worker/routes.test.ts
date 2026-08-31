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
      const response = await worker.fetch(new Request(`https://example.com${path}`), env);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain('id="outfitter-scope"');
    });
  }
  it("keeps public static routes available without a session", async () => {
    expect((await worker.fetch(new Request("https://example.com/docs/"), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://example.com/workflows/"), env)).status).toBe(200);
  });
  it("binds organization install pages to the organization in the route", async () => {
    const response = await worker.fetch(new Request("https://example.com/orgs/acme/install?workflow=review"), env);
    const page = await response.text();
    expect(page).toContain('const requestedAccount="acme"');
    expect(page).toContain("callbackURL:location.pathname+location.search");
  });
  it("escapes the organization before embedding it in the install page script", async () => {
    const response = await worker.fetch(new Request("https://example.com/orgs/%3C%2Fscript%3E/install"), env);
    expect(await response.text()).not.toContain('const requestedAccount="</script>"');
  });
  it("completes a verified GitHub installation return through the scope endpoint", async () => {
    const response = await worker.fetch(new Request("https://example.com/organizations?installation_id=7&setup_action=install"), env);
    const page = await response.text();
    expect(page).toContain("data.installationAccepted");
    expect(page).toContain("location.replace('/orgs/'");
  });
});
