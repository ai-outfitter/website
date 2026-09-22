import { beforeEach, describe, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ userRequest: vi.fn(), appRequest: vi.fn(), installationRequest: vi.fn(), authenticate: vi.fn(), session: vi.fn() }));
vi.mock("@octokit/core", () => ({ Octokit: class { request = deps.appRequest; } }));
vi.mock("@octokit/auth-app", () => ({ createAppAuth: () => deps.authenticate }));
vi.mock("../auth", () => ({ session: deps.session }));
vi.mock("../github", () => ({ github: async () => ({ request: deps.userRequest }) }));
vi.mock("../app", () => ({ installationOctokit: () => ({ request: deps.installationRequest }) }));
import { ownerOptions, triageGitHubToken } from "./github";
const workspace = { id: "org:12", login: "team", type: "Organization" as const };
const env = { GITHUB_APP_ID: "app", GITHUB_APP_PRIVATE_KEY: "private" } as unknown as Env;
const config = { workspace, installationId: 42, repositories: [{ id: 101, fullName: "team/app" }], enabled: true, credentialVersion: "v", revision: "r", generation: 1, deploymentFingerprint: "f", projectManagerName: "Mira", engineerName: "Eli" };
beforeEach(() => {
  vi.clearAllMocks(); deps.session.mockResolvedValue({ user: { githubUserId: 1 } });
  deps.userRequest.mockImplementation(async (route) => {
    if (route === "GET /users/{username}") return { data: { id: 12, login: "team", type: "Organization" } };
    if (route === "GET /user/memberships/orgs/{org}") return { data: { role: "admin", state: "active" } };
    if (route === "GET /user/installations") return { data: { installations: [{ id: 42, account: { id: 12 } }] } };
    throw new Error("Unexpected API request");
  });
  deps.appRequest.mockResolvedValue({ data: { account: { id: 12, login: "team" }, suspended_at: null } });
  deps.installationRequest.mockImplementation(async (route) => route === "GET /installation/repositories" ? { data: { repositories: [{ id: 101, full_name: "team/app", owner: { id: 12 } }, { id: 999, full_name: "other/app", owner: { id: 99 } }] } } : { data: { id: 101, full_name: "team/app", owner: { id: 12 } } });
  deps.authenticate.mockResolvedValue({ token: "scoped", expiresAt: "later" });
});
describe("resident GitHub ownership and credentials", () => {
  it("offers only repositories in the owner's verified installation", async () => { expect(await ownerOptions(new Request("https://outfitter"), env, "team")).toEqual({ workspace, installationId: 42, repositories: [{ id: 101, fullName: "team/app" }] }); });
  it("rejects active non-owner org members", async () => { deps.userRequest.mockImplementation(async (route) => route === "GET /users/{username}" ? { data: { id: 12, login: "team", type: "Organization" } } : { data: { role: "member", state: "active" } }); await expect(ownerOptions(new Request("https://outfitter"), env, "team")).rejects.toMatchObject({ status: 403 }); });
  it("rejects installations transferred to another owner or suspended", async () => { deps.appRequest.mockResolvedValueOnce({ data: { account: { id: 99, login: "team" } } }); await expect(ownerOptions(new Request("https://outfitter"), env, "team")).rejects.toMatchObject({ status: 403 }); deps.appRequest.mockResolvedValueOnce({ data: { account: { id: 12, login: "team" }, suspended_at: "now" } }); await expect(triageGitHubToken(env, config, 101)).rejects.toMatchObject({ status: 403 }); });
  it("mints only one selected repository with contents read and issues write", async () => { expect(await triageGitHubToken(env, config, 101)).toEqual({ token: "scoped", expires_at: "later" }); expect(deps.authenticate).toHaveBeenCalledExactlyOnceWith({ type: "installation", installationId: 42, repositoryIds: [101], permissions: { contents: "read", issues: "write", metadata: "read" } }); });
  it("rejects unselected and transferred repositories before minting", async () => { await expect(triageGitHubToken(env, config, 999)).rejects.toMatchObject({ status: 403 }); deps.installationRequest.mockResolvedValue({ data: { id: 101, full_name: "other/app", owner: { id: 99 } } }); await expect(triageGitHubToken(env, config, 101)).rejects.toMatchObject({ status: 403 }); expect(deps.authenticate).not.toHaveBeenCalled(); });
});
