import { describe, expect, it } from "vitest";
import { activeAccountCookie, installationReturnAccepted, readActiveAccount, viewedLogin, type ScopedAccount } from "./scope";

const accounts: ScopedAccount[] = [
  { login: "octo", type: "User", installationId: 1, hasAgentsRepository: true },
  { login: "acme", type: "Organization", installationId: 2, hasAgentsRepository: true },
];

describe("active and viewed account scope", () => {
  it("prefers the personal account and restores an accessible signed cookie", async () => {
    expect(await readActiveAccount(new Headers(), accounts, "octo", "secret")).toBe("octo");
    const cookie = await activeAccountCookie("acme", "secret");
    expect(await readActiveAccount(new Headers({ cookie: cookie.split(";")[0] }), accounts, "octo", "secret")).toBe("acme");
  });
  it("falls back when a cookie is stale, tampered, or no longer accessible", async () => {
    expect(await readActiveAccount(new Headers({ cookie: "outfitter_active_account=gone.1.invalid" }), accounts, "octo", "secret")).toBe("octo");
    const cookie = await activeAccountCookie("acme", "secret");
    expect(await readActiveAccount(new Headers({ cookie: cookie.replace("acme", "evil") }), accounts, "octo", "secret")).toBe("octo");
  });
  it("keeps an explicit public view separate from active scope", () => {
    expect(viewedLogin("/orgs/public-co/workflows/review")).toBe("public-co");
    expect(viewedLogin("/workflows/review")).toBeNull();
  });
  it("accepts an installation return only after it appears in the user's list", () => {
    expect(installationReturnAccepted("2", accounts)).toBe(true);
    expect(installationReturnAccepted("999", accounts)).toBe(false);
    expect(installationReturnAccepted("2x", accounts)).toBe(false);
  });
});
