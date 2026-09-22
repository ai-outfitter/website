import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), request: vi.fn() }));
vi.mock("./auth", () => ({ session: mocks.session }));
vi.mock("@octokit/core", () => ({ Octokit: class { request = mocks.request; } }));
const { authenticateCli, handleCli } = await import("./cli-auth");
const personal = { id: "user:1", login: "alice", type: "User" };
const org = { id: "org:2", login: "team", type: "Organization" };
const token = `${"a".repeat(20)}.${"b".repeat(64)}`;
let role: string, state: string, allowed: string[], selected: typeof personal, emailVerified: boolean;
const device = { authenticate: vi.fn(async () => ({ user: { id: "github:1" }, workspace: selected })), spenders: vi.fn(async (ids?: string[]) => ids ?? allowed), email: vi.fn(async () => "fallback@example.com"), select: vi.fn(async () => true), revoke: vi.fn(async () => true), rateLimit: vi.fn(async () => true), approve: vi.fn(async () => true) };
const env = { CLI_AUTH_ENABLED: "true", BETTER_AUTH_URL: "https://example.com", CLI_DEVICES: { getByName: () => device }, GITHUB_USER_GRANTS: { getByName: () => ({ getAccessToken: async () => "github-secret" }) } } as unknown as Env;
function request(path: string, method = "GET", body?: unknown, origin?: string) {
  return new Request(`https://example.com${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(origin ? { origin } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeEach(() => {
  vi.clearAllMocks(); role = "member"; state = "active"; allowed = []; selected = personal; emailVerified = true;
  mocks.session.mockResolvedValue({ user: { githubUserId: 1 } });
  mocks.request.mockImplementation(async (route: string) => {
    if (route === "GET /user") return { data: { id: 1, login: "alice" } };
    if (route === "GET /user/emails") return { data: [{ email: "verified@example.com", verified: emailVerified, primary: true }] };
    if (route === "GET /user/memberships/orgs") return { data: [{ role, state, organization: { id: 2, login: "team" } }] };
    if (route === "GET /organizations/{org_id}") return { data: { id: 2, login: "team" } };
    if (route === "GET /user/memberships/orgs/{org}") return { data: { role, state } };
    throw Error("unexpected request");
  });
});
describe("CLI authorization boundary", () => {
  it("is disabled by default", async () => {
    expect((await handleCli(request("/api/cli/me"), { ...env, CLI_AUTH_ENABLED: undefined })).status).toBe(404);
    expect(device.authenticate).not.toHaveBeenCalled();
  });
  it("uses stable identity and verified GitHub email with optional fallback", async () => {
    expect((await authenticateCli(request("/api/cli/me"), env)).user).toEqual({ id: "github:1", email: "verified@example.com" });
    emailVerified = false;
    expect((await authenticateCli(request("/api/cli/me"), env)).user.email).toBe("fallback@example.com");
  });
  it("allows owners and explicitly allowed active members only", async () => {
    selected = org;
    expect((await handleCli(request("/api/cli/me"), env)).status).toBe(403);
    allowed = ["github:1"];
    expect((await handleCli(request("/api/cli/me"), env)).status).toBe(200);
    state = "pending";
    expect((await handleCli(request("/api/cli/me"), env)).status).toBe(403);
    role = "admin"; state = "active"; allowed = [];
    expect((await handleCli(request("/api/cli/me"), env)).status).toBe(200);
    role = "member";
    expect((await handleCli(request("/api/cli/me"), env)).status).toBe(403);
  });
  it("requires explicit payer changes, and permits return to personal after org removal", async () => {
    expect((await handleCli(request("/api/cli/workspace", "PUT", { workspace_id: "org:2" }), env)).status).toBe(403);
    expect(device.select).not.toHaveBeenCalled();
    selected = org;
    const response = await handleCli(request("/api/cli/workspace", "PUT", { workspace_id: "user:1" }), env);
    expect(response.status).toBe(200);
    expect(device.select).toHaveBeenCalledWith("b".repeat(64), personal);
  });
  it("requires an owner and same-origin browser request to authorize spenders", async () => {
    const path = "/api/cli/organizations/2/spenders";
    expect((await handleCli(request(path, "PUT", { user_ids: ["github:3"] }, "https://evil.example"), env)).status).toBe(403);
    expect((await handleCli(request(path, "PUT", { user_ids: ["github:3"] }, "https://example.com"), env)).status).toBe(403);
    role = "admin";
    expect((await handleCli(request(path, "PUT", { user_ids: ["github:3"] }, "https://example.com"), env)).status).toBe(200);
  });
  it("rejects cross-origin approval and never approves on GET", async () => {
    expect((await handleCli(request("/api/cli/approve", "POST", { user_code: "a".repeat(20), action: "approve" }, "https://evil.example"), env)).status).toBe(403);
    expect((await handleCli(request("/api/cli/approve"), env)).status).toBe(404);
    expect(device.approve).not.toHaveBeenCalled();
    const page = await handleCli(request("/cli/authorize"), env);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(device.approve).not.toHaveBeenCalled();
  });
  it("rejects missing sessions and oversized bodies", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await handleCli(request("/api/cli/approve", "POST", { user_code: "a".repeat(20), action: "approve" }, "https://example.com"), env)).status).toBe(401);
    expect((await handleCli(request("/api/cli/token", "POST", { value: "x".repeat(5000) }), env)).status).toBe(413);
  });
  it("revokes without requiring a still-accessible organization", async () => {
    selected = org;
    expect((await handleCli(request("/api/cli/logout", "POST"), env)).status).toBe(204);
    expect(device.revoke).toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
