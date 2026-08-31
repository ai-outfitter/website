// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { startSiteAuth } from "./site-auth";

describe("site authentication navigation", () => {
  beforeEach(() => {
    document.body.innerHTML = '<nav><a id="site-auth" href="/dashboard/">Sign in</a></nav>';
  });

  it("keeps the sign-in link when no session exists", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "Sign in required" }, { status: 401 }));
    await startSiteAuth(document, fetcher as typeof fetch);
    expect(document.querySelector("#site-auth")?.textContent).toBe("Sign in");
  });

  it("shows the active organization", async () => {
    const fetcher = vi.fn(async () => Response.json({
      user: { name: "Nicholas" },
      activeAccount: { login: "ai-outfitter", type: "Organization" },
    }));
    await startSiteAuth(document, fetcher as typeof fetch);
    const link = document.querySelector<HTMLAnchorElement>("#site-auth");
    expect(link?.textContent).toBe("ai-outfitter");
    expect(link?.getAttribute("href")).toBe("/dashboard/?account=ai-outfitter");
    expect(link?.getAttribute("aria-label")).toBe("Manage organization ai-outfitter");
  });

  it("uses the dashboard account event without a duplicate request", async () => {
    document.body.insertAdjacentHTML("beforeend", '<main data-dashboard></main>');
    const fetcher = vi.fn();
    await startSiteAuth(document, fetcher as typeof fetch);
    document.dispatchEvent(new CustomEvent("outfitter:account", { detail: {
      user: { name: "Nicholas" },
      activeAccount: { login: "ncrmro", type: "User" },
    } }));
    expect(fetcher).not.toHaveBeenCalled();
    expect(document.querySelector("#site-auth")?.textContent).toBe("ncrmro");
  });
});
