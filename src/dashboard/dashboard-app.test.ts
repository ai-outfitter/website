// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { startDashboard } from "../scripts/dashboard-app";

const fixture = `
  <section id="signed-out" hidden><button id="sign-in"></button></section>
  <section id="signed-in" hidden>
    <a id="install-app"></a>
    <section id="dashboard-overview" hidden>
      <h2 id="configuration-title"></h2><a id="repository-link"></a><div id="configuration-summary"></div>
      <details id="settings-details"><pre id="settings-yaml"></pre></details>
      <div id="catalog-sources"></div><section id="remote-source-section"><div id="remote-sources"></div></section>
      <div id="installed-workflows"></div><div id="community-workflows"></div>
      <div id="source-plan"><div id="source-preview"></div><div id="source-apply-actions"><button data-apply="pull-request"></button><button data-apply="direct"></button></div></div>
    </section>
    <section id="workflow-manager" hidden>
      <a id="manager-back"></a><h2 id="manager-title"></h2><span id="manager-state"></span><p id="manager-description"></p><dl id="manager-metadata"></dl>
      <select id="install-strategy"><option value="catalog-reference"></option><option value="vendored"></option></select>
      <div id="repository-options"></div><select id="visibility"><option value="public"></option></select><div id="workflow-actions"></div>
      <div id="workflow-preview"></div><div id="workflow-apply-actions"><button data-apply="pull-request"></button><button data-apply="direct"></button></div>
    </section>
  </section><p id="dashboard-status"></p>`;

const account = { login: "acme", type: "Organization", installationId: 7, repository: { fullName: "acme/.agents", defaultBranch: "main", private: true, canPush: true } };
const configuration = {
  login: "acme", repository: account.repository, repositoryUrl: "https://github.com/acme/.agents",
  settings: { exists: true, valid: true, raw: "# keep\nsources:\n  - github: ai-outfitter/community-profiles\n    ref: v1\n", defaults: {}, sources: [{ id: "sources:0", section: "sources", kind: "github", location: "ai-outfitter/community-profiles", github: "ai-outfitter/community-profiles", ref: "v1", dependencies: ["review"], repositoryUrl: "https://github.com/ai-outfitter/community-profiles" }] },
  workflows: [
    { id: "review", title: "Adversarial review", description: "Review a pull request.", sourceRepository: "ai-outfitter/community-profiles", sourceSha: "a".repeat(40), state: "outdated", strategy: "catalog-reference" },
    { id: "founder", title: "Founder", description: "Plan the work.", sourceRepository: "ai-outfitter/community-profiles", sourceSha: "a".repeat(40), state: "add" },
  ],
};
function locationAt(url: string) { return { href: url, pathname: new URL(url).pathname, assign: vi.fn(), reload: vi.fn() } as unknown as Location; }
function historyAt() { return { replaceState: vi.fn() } as unknown as History; }

describe("dashboard client", () => {
  beforeEach(() => { document.body.innerHTML = fixture; });

  it("keeps the connect view without an authenticated session", async () => {
    await startDashboard(document, vi.fn(async () => Response.json({ error: "Sign in required" }, { status: 401 })) as typeof fetch, locationAt("https://example.com/dashboard/"));
    expect(document.querySelector<HTMLElement>("#signed-out")?.hidden).toBe(false);
  });

  it("renders repository configuration before loading asynchronous source freshness", async () => {
    let releaseFreshness: (() => void) | undefined;
    const freshnessWait = new Promise<void>((resolve) => { releaseFreshness = resolve; });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/accounts/acme/configuration") return Response.json(configuration);
      if (path === "/api/accounts") return Response.json({ user: { name: "Octo" }, activeAccount: account, accounts: [account], githubAppSlug: "ai-outfitter" });
      if (path.endsWith("/configuration/freshness")) { await freshnessWait; return Response.json({ sources: [{ id: "sources:0", status: "outdated", latestRef: "v2" }] }); }
      throw new Error(`Unexpected request: ${path}`);
    });
    const history = historyAt();
    await startDashboard(document, fetcher as typeof fetch, locationAt("https://example.com/dashboard/acme/"), history);
    expect(document.querySelector("#configuration-title")?.textContent).toBe("acme/.agents");
    expect(document.querySelector("#settings-yaml")?.textContent).toContain("# keep");
    expect(document.querySelector("#installed-workflows")?.textContent).toContain("Adversarial review");
    expect(document.querySelector("#community-workflows")?.textContent).toContain("Founder");
    expect(document.querySelector("[data-source-state]")?.textContent).toBe("checking");
    releaseFreshness!();
    await vi.waitFor(() => expect(document.querySelector("[data-source-state]")?.textContent).toBe("outdated"));
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/dashboard/acme/");
  });

  it("canonicalizes accountless installs and previews an explicit install action", async () => {
    const noRepository = { ...configuration, repository: null, settings: { exists: false, valid: true, raw: "", defaults: {}, sources: [] }, workflows: configuration.workflows.map((workflow) => ({ ...workflow, state: "add" })) };
    const fetcher = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      void options;
      const path = String(input);
      if (path === "/api/accounts") return Response.json({ user: {}, activeAccount: { ...account, repository: null }, accounts: [{ ...account, repository: null }], githubAppSlug: "ai-outfitter" });
      if (path === "/api/accounts/acme/configuration") return Response.json(noRepository);
      if (path === "/api/accounts/acme/plans") return Response.json({ token: "signed", plan: { baseSha: null, changes: [{ path: "settings.yml", action: "add", before: null, after: "sources: []\n" }] } });
      throw new Error(`Unexpected request: ${path}`);
    });
    const history = historyAt();
    await startDashboard(document, fetcher as typeof fetch, locationAt("https://example.com/dashboard/install/founder/"), history);
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/dashboard/acme/workflows/founder/");
    expect(document.querySelector("#manager-title")?.textContent).toBe("Founder");
    document.querySelector<HTMLButtonElement>("#workflow-actions button")?.click();
    await vi.waitFor(() => expect(document.querySelector("#workflow-preview")?.textContent).toContain("ADD settings.yml"));
    const planCall = fetcher.mock.calls.find(([path]) => path === "/api/accounts/acme/plans");
    expect(JSON.parse(String(planCall?.[1]?.body))).toMatchObject({ target: "workflow", workflow: "founder", action: "install", strategy: "catalog-reference" });
  });
});
