import { describe, expect, it } from "vitest";
import { activeAccountCookie, readActiveAccount, type ScopedAccount } from "./scope";

const accounts: ScopedAccount[] = [
  { login: "octo", type: "User", installationId: 1, repository: { fullName: "octo/.agents" } },
  { login: "acme", type: "Organization", installationId: 2, repository: { fullName: "acme/.agents" } },
];

describe("active account scope", () => {
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
});
