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
      if (route === "GET /user/installations/{installation_id}/repositories") {
        const owner = input.installation_id === 7 ? "octo" : "acme";
        return { data: { repositories: [
          { id: input.installation_id, name: ".agents", full_name: `${owner}/.agents`, owner: { login: owner }, default_branch: "main", private: true, permissions: { push: true } },
          { id: 20, name: "project", full_name: `${owner}/project`, owner: { login: owner }, default_branch: "main", private: false, permissions: { push: true } },
        ] } };
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
  });
});
