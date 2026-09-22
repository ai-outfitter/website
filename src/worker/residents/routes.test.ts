import { beforeEach, describe, expect, it, vi } from "vitest";
const github = vi.hoisted(() => ({ ownerOptions: vi.fn(), ownerWorkspace: vi.fn(), triageGitHubToken: vi.fn(), verifyInstallation: vi.fn() }));
vi.mock("./github", () => github);
vi.mock("../cli-auth", () => ({ authenticateCli: vi.fn(async () => ({ user: { id: "github:1" }, workspace: { id: "user:1" } })) }));
import { authenticateInference, residentRoute } from "./routes";
import { residentToken } from "./credentials";
const workspace = { id: "org:12", login: "team", type: "Organization" };
const config = { workspace, enabled: true, installationId: 42, repositories: [{ id: 101, fullName: "team/app" }], credentialVersion: "a".repeat(32) };
function setup() {
  const store = { authenticate: vi.fn(async () => config), status: vi.fn(async () => ({ enrolled: false })), enroll: vi.fn(async () => ({ state: "provisioning" })), disable: vi.fn(async () => ({ enabled: false })) };
  const namespace = { getByName: vi.fn(() => store) };
  return { store, namespace, env: { RESIDENTS_ENABLED: "true", RESIDENT_WORKSPACES: namespace, BETTER_AUTH_URL: "https://outfitter.test" } as unknown as Env };
}
const request = (path: string, method = "GET", body?: unknown, origin = "https://outfitter.test") => new Request(`https://outfitter.test${path}`, { method, headers: { origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); github.ownerWorkspace.mockResolvedValue({ workspace }); github.ownerOptions.mockResolvedValue({ workspace, installationId: 42, repositories: config.repositories }); github.verifyInstallation.mockResolvedValue(undefined); github.triageGitHubToken.mockResolvedValue({ token: "scoped", expires_at: "later" }); });

describe("resident API authorization", () => {
  it("keeps disabled APIs unavailable", async () => {
    const { env } = setup(); expect((await residentRoute(request("/api/residents/team"), { ...env, RESIDENTS_ENABLED: "false" } as unknown as Env))?.status).toBe(503);
    expect(github.ownerOptions).not.toHaveBeenCalled();
  });
  it("allows owner revocation while disabled without installation discovery", async () => {
    const { env, store } = setup(); github.ownerOptions.mockRejectedValue(new Error("installation removed"));
    const result = await residentRoute(request("/api/residents/team", "DELETE"), { ...env, RESIDENTS_ENABLED: "false" } as unknown as Env);
    expect(result?.status).toBe(200); expect(store.disable).toHaveBeenCalledOnce(); expect(github.ownerOptions).not.toHaveBeenCalled();
    github.ownerWorkspace.mockRejectedValue(new Response(null, { status: 403 }));
    expect((await residentRoute(request("/api/residents/team", "DELETE"), env))?.status).toBe(403);
  });
  it("requires same-origin ownership and derives all enrollment scope server-side", async () => {
    const { env, store, namespace } = setup();
    const body = { repository_ids: [101], projectManagerName: "Mira", engineerName: "Eli" };
    expect((await residentRoute(request("/api/residents/team", "PUT", body, "https://evil"), env))?.status).toBe(403);
    expect((await residentRoute(request("/api/residents/team", "PUT", { ...body, workspace: "org:999" }), env))?.status).toBe(400);
    expect((await residentRoute(request("/api/residents/team", "PUT", { ...body, repository_ids: [999] }), env))?.status).toBe(403);
    expect((await residentRoute(request("/api/residents/team", "PUT", body), env))?.status).toBe(202);
    expect(namespace.getByName).toHaveBeenCalledWith("org:12");
    expect(store.enroll).toHaveBeenCalledExactlyOnceWith({ workspace, installationId: 42, repositories: config.repositories, projectManagerName: "Mira", engineerName: "Eli" });
  });
  it("does not enroll when GitHub owner authorization fails", async () => {
    const { env, store } = setup(); github.ownerOptions.mockRejectedValue(new Response(null, { status: 403 }));
    expect((await residentRoute(request("/api/residents/team", "PUT", {}), env))?.status).toBe(403); expect(store.enroll).not.toHaveBeenCalled();
  });
  it("binds resident inference to its workspace and a separate nonhuman identity", async () => {
    const { env, namespace } = setup();
    const token = await residentToken(btoa("a".repeat(32)), "org:12", "project-manager", "a".repeat(32));
    const identity = await authenticateInference(new Request("https://outfitter.test/v1/models", { headers: { authorization: `Bearer ${token}` } }), env);
    expect(identity).toEqual({ user: { id: "resident:org:12:project-manager" }, workspace });
    expect(namespace.getByName).toHaveBeenCalledWith("org:12"); expect(github.verifyInstallation).toHaveBeenCalledWith(env, workspace, 42);
  });
  it("rejects revoked resident credentials without CLI fallback", async () => {
    const { env, store } = setup(); store.authenticate.mockResolvedValue(null as never);
    const token = await residentToken(btoa("a".repeat(32)), "org:12", "engineer", "a".repeat(32));
    await expect(authenticateInference(new Request("https://outfitter.test/v1/models", { headers: { authorization: `Bearer ${token}` } }), env)).rejects.toMatchObject({ status: 401 });
  });
  it("brokers only the requested numeric repository through the authorized enrollment", async () => {
    const { env } = setup(); const token = await residentToken(btoa("a".repeat(32)), "org:12", "engineer", "a".repeat(32));
    const response = await residentRoute(new Request("https://outfitter.test/api/residents/github-token", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ repository_id: 101 }) }), env);
    expect(response?.status).toBe(200); expect(github.triageGitHubToken).toHaveBeenCalledWith(env, config, 101);
  });
});
