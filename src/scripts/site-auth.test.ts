// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { startSiteAuth } from "./site-auth";

function locationAt(pathname = "/") {
  return { pathname, assign: vi.fn(), reload: vi.fn() } as unknown as Location;
}

describe("site authentication navigation", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <nav>
        <a id="site-auth" href="/dashboard/" hidden>Sign in</a>
        <details id="site-account" hidden>
          <summary id="site-account-trigger">Account</summary>
          <div id="site-account-options"></div>
          <button id="site-sign-out"></button>
        </details>
      </nav>`;
  });

  it("keeps the sign-in link when no session exists", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "Sign in required" }, { status: 401 }));
    await startSiteAuth(document, fetcher as typeof fetch);
    expect(document.querySelector("#site-auth")?.textContent).toBe("Sign in");
    expect(document.querySelector<HTMLAnchorElement>("#site-auth")?.hidden).toBe(false);
  });

  it("shows the active account and the three latest organizations", async () => {
    const fetcher = vi.fn(async () => Response.json({
      user: { name: "Nicholas" },
      activeAccount: { login: "ai-outfitter", type: "Organization" },
      accounts: [
        { login: "old", type: "Organization", updatedAt: "2026-01-01T00:00:00Z" },
        { login: "ai-outfitter", type: "Organization", updatedAt: "2026-08-30T00:00:00Z" },
        { login: "Unsupervisedcom", type: "Organization", updatedAt: "2026-08-31T00:00:00Z" },
        { login: "ks.systems", type: "Organization", updatedAt: "2026-08-29T00:00:00Z" },
        { login: "ncrmro", type: "User", updatedAt: "2026-08-31T00:00:00Z" },
      ],
    }));
    await startSiteAuth(document, fetcher as typeof fetch);
    const link = document.querySelector<HTMLAnchorElement>("#site-auth");
    expect(link?.hidden).toBe(true);
    expect(document.querySelector<HTMLDetailsElement>("#site-account")?.hidden).toBe(false);
    expect(document.querySelector("#site-account-trigger")?.textContent).toBe("ai-outfitter");
    expect([...document.querySelectorAll<HTMLAnchorElement>("#site-account-options a")].map((option) => [option.textContent, option.pathname])).toEqual([
      ["Unsupervisedcom", "/dashboard/Unsupervisedcom/"],
      ["ai-outfitter", "/dashboard/ai-outfitter/"],
      ["ks.systems", "/dashboard/ks.systems/"],
    ]);
  });

  it("uses the dashboard account event without a duplicate request", async () => {
    document.body.insertAdjacentHTML("beforeend", '<main data-dashboard></main>');
    const fetcher = vi.fn();
    await startSiteAuth(document, fetcher as typeof fetch);
    document.dispatchEvent(new CustomEvent("outfitter:account", { detail: {
      user: { name: "Nicholas" },
      activeAccount: { login: "ncrmro", type: "User" },
      accounts: [],
    } }));
    expect(fetcher).not.toHaveBeenCalled();
    expect(document.querySelector("#site-account-trigger")?.textContent).toBe("ncrmro");
  });

  it("switches organization scope and signs out from the account menu", async () => {
    const index = {
      user: { name: "Nicholas" },
      activeAccount: { login: "ai-outfitter", type: "Organization" },
      accounts: [
        { login: "ai-outfitter", type: "Organization" },
        { login: "Unsupervisedcom", type: "Organization" },
      ],
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/accounts"
      ? Response.json(index)
      : Response.json({ activeAccount: index.accounts[1] }));
    const location = locationAt();
    await startSiteAuth(document, fetcher as typeof fetch, location);

    document.querySelector<HTMLAnchorElement>('a[href="/dashboard/Unsupervisedcom/"]')?.click();
    await vi.waitFor(() => expect(location.assign).toHaveBeenCalled());
    expect(fetcher).toHaveBeenCalledWith("/api/accounts/active", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ login: "Unsupervisedcom" }),
    }));

    document.querySelector<HTMLButtonElement>("#site-sign-out")?.click();
    await vi.waitFor(() => expect(location.reload).toHaveBeenCalled());
    expect(fetcher).toHaveBeenCalledWith("/api/auth/sign-out", expect.objectContaining({ method: "POST" }));
  });

  it("preserves the selected workflow when switching organizations", async () => {
    const index = {
      user: {}, activeAccount: { login: "ai-outfitter", type: "Organization" },
      accounts: [{ login: "ai-outfitter", type: "Organization" }, { login: "Unsupervisedcom", type: "Organization" }],
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/accounts" ? Response.json(index) : Response.json({ activeAccount: index.accounts[1] }));
    const location = locationAt("/dashboard/ai-outfitter/workflows/adversarial-review/");
    await startSiteAuth(document, fetcher as typeof fetch, location);
    expect(document.querySelector<HTMLAnchorElement>('#site-account-options a[href="/dashboard/Unsupervisedcom/workflows/adversarial-review/"]')).not.toBeNull();
  });
});
