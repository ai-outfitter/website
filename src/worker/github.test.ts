import { describe, expect, it, vi } from "vitest";
import { accounts, localGitHubToken, tokenAccounts } from "./github";

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

describe("local PAT development", () => {
  it("accepts a PAT only when the local-development gate is explicit", () => {
    const env = { LOCAL_GITHUB_AUTH: "true", LOCAL_GITHUB_TOKEN: " secret ", LOCAL_DEV_PORT: "4321" } as Env;
    const localRequest = new Request("http://localhost:4321/api/accounts");
    expect(localGitHubToken(env, localRequest, true)).toBe("secret");
    expect(localGitHubToken(env, localRequest, false)).toBeNull();
    expect(localGitHubToken({ LOCAL_GITHUB_TOKEN: "secret" } as Env, localRequest, true)).toBeNull();
    expect(localGitHubToken({ LOCAL_GITHUB_AUTH: "false", LOCAL_GITHUB_TOKEN: "secret" } as Env, localRequest, true)).toBeNull();
  });

  it("rejects cross-origin browser requests", () => {
    const env = { LOCAL_GITHUB_AUTH: "true", LOCAL_GITHUB_TOKEN: "secret", LOCAL_DEV_PORT: "4321" } as Env;
    expect(localGitHubToken(env, new Request("http://localhost:4321/api/accounts", {
      headers: { host: "localhost:4321", origin: "https://attacker.example" },
    }), true)).toBeNull();
    expect(localGitHubToken(env, new Request("http://localhost:4321/api/accounts", {
      headers: { host: "localhost:4321", origin: "http://localhost:4321" },
    }), true)).toBe("secret");
    expect(localGitHubToken(env, new Request("http://localhost:4321/api/accounts", {
      headers: { host: "localhost:4321", origin: "http://localhost:9999" },
    }), true)).toBeNull();
  });

  it("discovers the PAT owner and organizations with exact .agents lookups", async () => {
    const request = vi.fn(async (route: string, input: Record<string, unknown>) => {
      if (route === "GET /user") return { data: { id: 7, login: "octo", name: "Octo" } };
      if (route === "GET /user/orgs") return { data: [{ login: "acme" }] };
      if (route === "GET /repos/{owner}/{repo}") {
        const owner = String(input.owner);
        if (owner === "acme") throw Object.assign(new Error("missing"), { status: 404 });
        return { data: { id: 7, full_name: "octo/.agents", default_branch: "main", private: true, permissions: { push: true } } };
      }
      throw new Error(`Unexpected request: ${route}`);
    });

    await expect(tokenAccounts({ request } as never, "acme")).resolves.toEqual([
      { login: "acme", type: "Organization", installationId: null, repository: null },
      { login: "octo", type: "User", installationId: null, repository: {
        id: 7, fullName: "octo/.agents", owner: "octo", defaultBranch: "main", private: true, canPush: true,
      } },
    ]);
    expect(request.mock.calls.filter(([route]) => route === "GET /repos/{owner}/{repo}")).toHaveLength(2);
  });
});
