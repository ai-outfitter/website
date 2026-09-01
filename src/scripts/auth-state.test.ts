// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cachedAuthState, resetAuthStateForTests, resolveAuthState } from "./auth-state";

const index = {
  user: { name: "Nicholas" },
  activeAccount: { login: "ai-outfitter", type: "Organization" as const },
  accounts: [{ login: "ai-outfitter", type: "Organization" as const }],
  githubAppSlug: "ai-outfitter",
};

describe("client authentication state", () => {
  beforeEach(() => {
    resetAuthStateForTests();
    sessionStorage.clear();
  });

  it("deduplicates account requests and reuses a fresh session snapshot", async () => {
    const fetcher = vi.fn(async () => Response.json(index));
    const [first, concurrent] = await Promise.all([
      resolveAuthState(fetcher as typeof fetch, sessionStorage, 1_000),
      resolveAuthState(fetcher as typeof fetch, sessionStorage, 1_000),
    ]);
    const cached = await resolveAuthState(fetcher as typeof fetch, sessionStorage, 30_000);
    expect(first).toEqual(concurrent);
    expect(cached).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("revalidates an older snapshot and expires it after five minutes", async () => {
    const fetcher = vi.fn(async () => Response.json(index));
    await resolveAuthState(fetcher as typeof fetch, sessionStorage, 1_000);
    await resolveAuthState(fetcher as typeof fetch, sessionStorage, 62_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    resetAuthStateForTests();
    expect(cachedAuthState(sessionStorage, 400_000)).toBeNull();
  });

  it("records only an authoritative 401 as signed out", async () => {
    const signedOut = await resolveAuthState(
      vi.fn(async () => Response.json({ error: "Sign in required" }, { status: 401 })) as typeof fetch,
      sessionStorage,
      1_000,
    );
    expect(signedOut.status).toBe("signed-out");
    expect(cachedAuthState(sessionStorage, 1_001)).toEqual(signedOut);
  });
});
