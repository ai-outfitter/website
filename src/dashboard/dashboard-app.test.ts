// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardController, installDashboardLifecycle, startDashboard } from "../scripts/dashboard-app";
import { resetAuthStateForTests, resolveAuthState } from "../scripts/auth-state";
import { renderWorkflowDiagram } from "../scripts/workflow-diagram";

vi.mock("../scripts/workflow-diagram", () => ({ renderWorkflowDiagram: vi.fn(async () => undefined) }));

const fixture = `
  <section id="signed-out" hidden><button id="sign-in"></button></section>
  <section id="signed-in" hidden>
    <section id="dashboard-overview" hidden>
      <h2 id="configuration-title"></h2><a id="repository-link"></a><div id="configuration-summary"></div>
      <div id="catalog-sources"></div><section id="remote-source-section"><div id="remote-sources"></div></section>
      <div id="installed-workflows"></div><div id="community-workflows"></div>
      <div id="source-plan"><div id="source-preview"></div><div id="source-apply-actions"><button data-apply="pull-request"></button><button data-apply="direct"></button></div></div>
    </section>
    <section id="workflow-manager" hidden>
      <a id="manager-back"></a><h2 id="manager-title"></h2><span id="manager-state"></span><p id="manager-description"></p><dl id="manager-metadata"></dl>
      <section id="manager-graph"><figure id="manager-workflow-graph"><div class="workflow-diagram__canvas"></div><p class="workflow-diagram__status"></p><script data-workflow-source></script><script data-workflow-nodes></script></figure></section>
      <script id="dashboard-workflow-graphs" type="application/json">{"review":{"title":"Adversarial review","source":"flowchart LR\\n  inspect[Inspect]","nodes":[{"id":"inspect","title":"Inspect","kind":"step","details":[]},{"id":"nested","title":"Founder","kind":"workflow","href":"/workflows/founder/","details":[]}]}}</script>
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
  beforeEach(() => {
    vi.mocked(renderWorkflowDiagram).mockClear();
    resetAuthStateForTests();
    sessionStorage.clear();
    document.body.innerHTML = fixture;
  });

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

  it("reuses authentication state when dashboard content is replaced", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/accounts") return Response.json({ user: {}, activeAccount: account, accounts: [account], githubAppSlug: "ai-outfitter" });
      if (path === "/api/accounts/acme/configuration") return Response.json(configuration);
      if (path.endsWith("/configuration/freshness")) return Response.json({ sources: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    await startDashboard(document, fetcher as typeof fetch, locationAt("https://example.com/dashboard/acme/"), historyAt());
    document.body.innerHTML = fixture;
    await startDashboard(document, fetcher as typeof fetch, locationAt("https://example.com/dashboard/acme/workflows/review/"), historyAt());
    expect(fetcher.mock.calls.filter(([path]) => path === "/api/accounts")).toHaveLength(1);
    expect(document.querySelector("#manager-title")?.textContent).toBe("Adversarial review");
    expect(document.querySelector("[data-workflow-source]")?.textContent).toContain("flowchart LR");
    expect(JSON.parse(document.querySelector("[data-workflow-nodes]")?.textContent ?? "[]")[1].href).toBe("/dashboard/acme/workflows/founder/");
    expect(renderWorkflowDiagram).toHaveBeenCalledWith(document.querySelector("#manager-workflow-graph"), "dashboard-review", expect.any(AbortSignal));
  });

  it("clears a stale session snapshot when protected configuration returns 401", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/accounts"
      ? Response.json({ user: {}, activeAccount: account, accounts: [account], githubAppSlug: "ai-outfitter" })
      : Response.json({ error: "Sign in required" }, { status: 401 }));
    await startDashboard(document, fetcher as typeof fetch, locationAt("https://example.com/dashboard/acme/"), historyAt());
    expect(document.querySelector<HTMLElement>("#signed-out")?.hidden).toBe(false);
    expect(sessionStorage.length).toBe(0);
  });

  it("rechecks a signed-out snapshot after GitHub returns to the dashboard", async () => {
    await resolveAuthState(
      vi.fn(async () => Response.json({ error: "Sign in required" }, { status: 401 })) as typeof fetch,
      sessionStorage,
      Date.now(),
    );
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/accounts") return Response.json({ user: {}, activeAccount: account, accounts: [account], githubAppSlug: "ai-outfitter" });
      if (path === "/api/accounts/acme/configuration") return Response.json(configuration);
      if (path.endsWith("/configuration/freshness")) return Response.json({ sources: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    await startDashboard(document, fetcher as typeof fetch, locationAt("https://example.com/dashboard/acme/"), historyAt());
    expect(fetcher.mock.calls.filter(([path]) => path === "/api/accounts")).toHaveLength(1);
    expect(document.querySelector<HTMLElement>("#signed-in")?.hidden).toBe(false);
  });

  it("refreshes accounts before accepting a returned GitHub App installation", async () => {
    const previous = { ...account, installationId: 7 };
    const installed = { ...account, login: "new-org", installationId: 9 };
    await resolveAuthState(vi.fn(async () => Response.json({ user: {}, activeAccount: previous, accounts: [previous], githubAppSlug: "ai-outfitter" })) as typeof fetch, sessionStorage, Date.now());
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/accounts") return Response.json({ user: {}, activeAccount: previous, accounts: [previous, installed], githubAppSlug: "ai-outfitter" });
      if (path === "/api/accounts/active") return Response.json({ activeAccount: installed });
      if (path === "/api/accounts/new-org/configuration") return Response.json({ ...configuration, login: "new-org" });
      if (path.endsWith("/configuration/freshness")) return Response.json({ sources: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    await startDashboard(document, fetcher as typeof fetch, locationAt("https://example.com/dashboard/?installation_id=9"), historyAt());
    expect(fetcher.mock.calls.filter(([path]) => path === "/api/accounts")).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith("/api/accounts/active", expect.objectContaining({ body: JSON.stringify({ login: "new-org" }) }));
  });

  it("does not mutate the page or active account after disposal", async () => {
    let release: ((response: Response) => void) | undefined;
    const accounts = new Promise<Response>((resolve) => { release = resolve; });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/accounts" ? accounts : Response.json({ activeAccount: account }));
    const controller = new DashboardController(document, fetcher as typeof fetch, locationAt("https://example.com/dashboard/?installation_id=7"), historyAt());
    const started = controller.start();
    controller.dispose();
    release!(Response.json({ user: {}, activeAccount: account, accounts: [account], githubAppSlug: "ai-outfitter" }));
    await started;
    expect(fetcher.mock.calls.some(([path]) => path === "/api/accounts/active")).toBe(false);
    expect(document.querySelector<HTMLElement>("#signed-in")?.hidden).toBe(true);
  });

  it("does not start the dashboard controller after navigating outside the dashboard", () => {
    document.body.innerHTML = "<main>Marketing page</main>";
    const fetcher = vi.spyOn(globalThis, "fetch");
    installDashboardLifecycle(document)();
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRestore();
  });
});
