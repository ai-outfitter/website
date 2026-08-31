// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { startDashboard } from "../scripts/dashboard";

const fixture = `
  <section id="signed-out"><button id="sign-in"></button></section>
  <section id="signed-in" hidden>
    <select id="account"></select><a id="install-app"></a><button id="sign-out"></button>
    <div id="account-cards"></div><h2 id="manager-title"></h2><a id="repository-link"></a>
    <select id="workflow"></select><p id="workflow-description"></p><div id="local-readiness"></div>
    <div id="create-repository"><select id="visibility"><option value="public">Public</option></select><button id="create"></button></div>
    <div id="manage-repository"><div id="resources"></div><button id="preview"></button><div id="preview-output"></div><div id="apply-actions"><button id="open-pr"></button><button id="direct-commit"></button></div></div>
    <div id="workflow-cards"></div>
  </section>
  <p id="dashboard-status"></p>
`;

function locationAt(url = "https://example.com/dashboard/") {
  return { href: url, assign: vi.fn(), reload: vi.fn() } as unknown as Location;
}

describe("dashboard client", () => {
  beforeEach(() => {
    document.body.innerHTML = fixture;
  });

  it("keeps the connect view when no authenticated account session exists", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "Sign in required" }, { status: 401 }));
    await startDashboard(document, fetcher as typeof fetch, locationAt());
    expect(document.querySelector<HTMLElement>("#signed-out")?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#signed-in")?.hidden).toBe(true);
  });

  it("renders the exact account repository and workflow state", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/accounts") return Response.json({
        user: { name: "Octo" },
        activeAccount: { login: "acme", type: "Organization", installationId: 7, repository: { fullName: "acme/.agents", defaultBranch: "main", private: true, canPush: true } },
        accounts: [{ login: "acme", type: "Organization", installationId: 7, repository: { fullName: "acme/.agents", defaultBranch: "main", private: true, canPush: true }, active: true, counts: { installed: 1, outdated: 0, overridden: 0 } }],
        githubAppSlug: "ai-outfitter",
      });
      if (path === "/api/accounts/acme/workflows") return Response.json({
        login: "acme",
        repository: { fullName: "acme/.agents", defaultBranch: "main", private: true, canPush: true },
        repositoryUrl: "https://github.com/acme/.agents",
        workflows: [{ id: "review", title: "Adversarial review", description: "Review a pull request.", sourceSha: "a".repeat(40), state: "installed", action: "none" }],
      });
      if (path === "/api/accounts/acme/repository/resources") return Response.json({ resources: [{ path: "workflows/review", files: 1 }] });
      throw new Error(`Unexpected request: ${path}`);
    });

    await startDashboard(document, fetcher as typeof fetch, locationAt());

    expect(document.querySelector<HTMLElement>("#signed-in")?.hidden).toBe(false);
    expect(document.querySelector("#manager-title")?.textContent).toBe("acme/.agents");
    expect(document.querySelector("#local-readiness")?.textContent).toContain("available");
    expect(document.querySelector("#resources")?.textContent).toContain("workflows/review");
    expect(document.querySelector("#workflow-cards")?.textContent).toContain("Adversarial review");
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      "/api/accounts",
      "/api/accounts/acme/workflows",
      "/api/accounts/acme/repository/resources",
    ]);
  });
});
