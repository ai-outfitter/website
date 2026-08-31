import { describe, expect, it, vi } from "vitest";
import { accounts, localGitHubToken, sourceFreshness, tokenAccounts } from "./github";

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

  it("lists accounts without repository discovery for navigation", async () => {
    const request = vi.fn(async (route: string) => {
      if (route === "GET /user") return { data: { login: "octo" } };
      if (route === "GET /user/installations") return { data: { installations: [
        { id: 8, updated_at: "2026-08-31T00:00:00Z", account: { login: "acme", type: "Organization" } },
      ] } };
      throw new Error(`Unexpected request: ${route}`);
    });

    expect(await accounts({ request } as never, { repositories: false })).toEqual([{
      login: "acme",
      type: "Organization",
      installationId: 8,
      repository: null,
      updatedAt: "2026-08-31T00:00:00Z",
    }]);
    expect(request).not.toHaveBeenCalledWith("GET /repos/{owner}/{repo}", expect.anything());
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

  it("lists PAT accounts without repository discovery for navigation", async () => {
    const request = vi.fn(async (route: string) => {
      if (route === "GET /user") return { data: { id: 7, login: "octo", name: "Octo" } };
      if (route === "GET /user/orgs") return { data: [{ login: "acme" }] };
      throw new Error(`Unexpected request: ${route}`);
    });

    await expect(tokenAccounts({ request } as never, "", { repositories: false })).resolves.toEqual([
      { login: "acme", type: "Organization", installationId: null, repository: null },
      { login: "octo", type: "User", installationId: null, repository: null },
    ]);
    expect(request).not.toHaveBeenCalledWith("GET /repos/{owner}/{repo}", expect.anything());
  });
});

describe("catalog source freshness", () => {
  it("uses the latest non-draft release and classifies an older ref", async () => {
    const request = vi.fn(async (route: string, input: Record<string, unknown>) => {
      if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "main" } };
      if (route === "GET /repos/{owner}/{repo}/releases/latest") return { data: { tag_name: "v2" } };
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}") return { data: { sha: input.ref === "v2" ? "latest" : "current" } };
      if (route === "GET /repos/{owner}/{repo}/compare/{basehead}") return { data: { status: "ahead" } };
      throw new Error(`Unexpected request: ${route}`);
    });
    await expect(sourceFreshness({ request } as never, "ai-outfitter/community-profiles", "v1")).resolves.toMatchObject({ status: "outdated", latestRef: "v2", latestSha: "latest", latestKind: "release" });
  });

  it("falls back to an exact default-branch SHA when no release exists", async () => {
    const request = vi.fn(async (route: string, input: Record<string, unknown>) => {
      if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "main" } };
      if (route === "GET /repos/{owner}/{repo}/releases/latest") throw Object.assign(new Error("missing"), { status: 404 });
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}") return { data: { sha: input.ref === "main" ? "f".repeat(40) : "old" } };
      if (route === "GET /repos/{owner}/{repo}/compare/{basehead}") return { data: { status: "ahead" } };
      throw new Error(`Unexpected request: ${route}`);
    });
    await expect(sourceFreshness({ request } as never, "example/catalog", "old")).resolves.toMatchObject({ status: "outdated", latestRef: "f".repeat(40), latestKind: "default-branch" });
  });
});
