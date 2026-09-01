// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSiteAuth } from "./site-auth";
import { resetAuthStateForTests } from "./auth-state";

function locationAt(pathname = "/") {
  return { pathname, assign: vi.fn(), reload: vi.fn() } as unknown as Location;
}

describe("site authentication navigation", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    resetAuthStateForTests();
    sessionStorage.clear();
    document.body.innerHTML = `
      <nav>
        <span id="site-auth-loading">Loading account…</span>
        <a id="site-auth" href="/dashboard/" hidden>Sign in</a>
        <details id="site-account" hidden>
          <summary id="site-account-trigger">Account</summary>
          <div id="site-account-options"></div>
          <a id="site-add-organization"></a>
          <button id="site-sign-out"></button>
        </details>
      </nav>`;
  });

  it("keeps the sign-in link when no session exists", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "Sign in required" }, { status: 401 }));
    await startSiteAuth(document, fetcher as typeof fetch, locationAt(), false);
    expect(document.querySelector("#site-auth")?.textContent).toBe("Sign in");
    expect(document.querySelector<HTMLAnchorElement>("#site-auth")?.hidden).toBe(false);
  });

  it("shows every available organization and personal account", async () => {
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
      githubAppSlug: "ai-outfitter",
    }));
    await startSiteAuth(document, fetcher as typeof fetch, locationAt(), false);
    const link = document.querySelector<HTMLAnchorElement>("#site-auth");
    expect(link?.hidden).toBe(true);
    expect(document.querySelector<HTMLDetailsElement>("#site-account")?.hidden).toBe(false);
    expect(document.querySelector("#site-account-trigger")?.textContent).toBe("ai-outfitter");
    expect([...document.querySelectorAll<HTMLAnchorElement>("#site-account-options a")].map((option) => [option.textContent, option.pathname])).toEqual([
      ["Unsupervisedcom", "/dashboard/Unsupervisedcom/"],
      ["ncrmro", "/dashboard/ncrmro/"],
      ["ai-outfitter", "/dashboard/ai-outfitter/"],
      ["ks.systems", "/dashboard/ks.systems/"],
      ["old", "/dashboard/old/"],
    ]);
  });

  it("shows Add organization for an authenticated user without an active account", async () => {
    const fetcher = vi.fn(async () => Response.json({
      user: { name: "Nicholas" },
      activeAccount: null,
      accounts: [],
      githubAppSlug: "outfitter-app",
    }));
    await startSiteAuth(document, fetcher as typeof fetch, locationAt(), false);
    expect(document.querySelector("#site-account-trigger")?.textContent).toBe("Nicholas");
    expect(document.querySelector<HTMLAnchorElement>("#site-add-organization")?.href).toBe("https://github.com/apps/outfitter-app/installations/new");
    expect(document.querySelector("#site-add-organization")?.nextElementSibling?.id).toBe("site-sign-out");
  });

  it("switches organization scope and signs out from the account menu", async () => {
    const index = {
      user: { name: "Nicholas" },
      activeAccount: { login: "ai-outfitter", type: "Organization" },
      accounts: [
        { login: "ai-outfitter", type: "Organization" },
        { login: "Unsupervisedcom", type: "Organization" },
      ],
      githubAppSlug: "ai-outfitter",
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/accounts"
      ? Response.json(index)
      : Response.json({ activeAccount: index.accounts[1] }));
    const location = locationAt();
    await startSiteAuth(document, fetcher as typeof fetch, location, false);

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
      accounts: [{ login: "ai-outfitter", type: "Organization" }, { login: "Unsupervisedcom", type: "Organization" }], githubAppSlug: "ai-outfitter",
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/accounts" ? Response.json(index) : Response.json({ activeAccount: index.accounts[1] }));
    const location = locationAt("/dashboard/ai-outfitter/workflows/adversarial-review/");
    await startSiteAuth(document, fetcher as typeof fetch, location, false);
    expect(document.querySelector<HTMLAnchorElement>('#site-account-options a[href="/dashboard/Unsupervisedcom/workflows/adversarial-review/"]')).not.toBeNull();
  });

  it("backs off, expires stale navigation, and recovers after a sustained outage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const index = {
      user: {}, activeAccount: { login: "ai-outfitter", type: "Organization" },
      accounts: [{ login: "ai-outfitter", type: "Organization" }], githubAppSlug: "ai-outfitter",
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(index))
      .mockResolvedValueOnce(Response.json({ error: "Unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ error: "Unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ error: "Unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ error: "Unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ error: "Unavailable" }, { status: 503 }))
      .mockResolvedValue(Response.json(index));
    await startSiteAuth(document, fetcher as typeof fetch, locationAt(), true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(210_001);
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(document.querySelector<HTMLElement>("#site-auth-loading")?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#site-auth")?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#site-account")?.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetcher).toHaveBeenCalledTimes(7);
    expect(document.querySelector<HTMLElement>("#site-auth")?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#site-account")?.hidden).toBe(false);
  });
});
