import { describe, expect, it, vi } from "vitest";
import { accounts } from "./github";

describe("account .agents repository discovery", () => {
  it("discovers only the exact account repository and never inspects nested directories", async () => {
    const request = vi.fn(async (route: string, input: Record<string, unknown>) => {
      if (route === "GET /user") return { data: { login: "octo" } };
      if (route === "GET /user/installations") return { data: { installations: [
        { id: 7, account: { login: "octo", type: "User" } },
        { id: 8, account: { login: "acme", type: "Organization" } },
      ] } };
      if (route === "GET /repos/{owner}/{repo}") {
        const owner = String(input.owner);
        return { data: { id: owner === "octo" ? 7 : 8, full_name: `${owner}/.agents`, default_branch: "main", private: true, permissions: { push: true } } };
      }
      throw new Error(`Unexpected request: ${route}`);
    });

    const result = await accounts({ request } as never);

    expect(result.map((account) => ({
      login: account.login,
      type: account.type,
      repository: account.repository?.fullName,
    }))).toEqual([
      { login: "acme", type: "Organization", repository: "acme/.agents" },
      { login: "octo", type: "User", repository: "octo/.agents" },
    ]);
    expect(request.mock.calls.some(([route]) => String(route).includes("contents"))).toBe(false);
    expect(request.mock.calls.filter(([route]) => route === "GET /repos/{owner}/{repo}")).toHaveLength(2);
    expect(request.mock.calls.some(([route]) => String(route).includes("installations/{installation_id}/repositories"))).toBe(false);
  });
});
