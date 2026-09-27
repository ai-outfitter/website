import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), request: vi.fn() }));
vi.mock("./auth", () => ({ session: mocks.session }));
vi.mock("@octokit/core", () => ({ Octokit: class { request = mocks.request; } }));
const { handleInternalAuth } = await import("./internal-auth");
const user = { id: "github:1", login: "alice" };
const token = `${"a".repeat(20)}.${"b".repeat(64)}`;
const device = { authenticate: vi.fn(async () => ({ user })), revoke: vi.fn(async () => true), rateLimit: vi.fn(async () => true), approve: vi.fn(async () => true), create: vi.fn(async () => true), exchange: vi.fn(async () => ({ access: "c".repeat(64), refresh: "d".repeat(64), expires_in: 900 })) };
const env = { INTERNAL_INFERENCE_ENABLED: "true", INTERNAL_USERS: "github:1", BETTER_AUTH_URL: "https://example.com", INTERNAL_DEVICES: { getByName: () => device }, GITHUB_USER_GRANTS: { getByName: () => ({ getAccessToken: async () => "github-secret" }) } } as unknown as Env;
function request(path: string, method = "GET", body?: unknown, origin?: string, bearer = true) {
  return new Request(`https://example.com${path}`, { method, headers: { ...(bearer ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...(origin ? { origin } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ user: { githubUserId: 1 } });
  mocks.request.mockResolvedValue({ data: { id: 1, login: "alice" } });
});
describe("internal authentication", () => {
  it("denies disabled access while preserving logout", async () => {
    const disabled = { ...env, INTERNAL_INFERENCE_ENABLED: "false" };
    expect((await handleInternalAuth(request("/api/cli/me"), disabled)).status).toBe(404);
    expect(device.authenticate).not.toHaveBeenCalled();
    expect((await handleInternalAuth(request("/api/cli/logout", "POST"), disabled)).status).toBe(204);
  });
  it("checks the allowlist on every bearer and browser request", async () => {
    for (const bearer of [true, false]) {
      expect(await (await handleInternalAuth(request("/api/cli/me", "GET", undefined, undefined, bearer), env)).json()).toEqual({ user });
      expect((await handleInternalAuth(request("/api/cli/me", "GET", undefined, undefined, bearer), { ...env, INTERNAL_USERS: "github:2" })).status).toBe(403);
    }
  });
  it("never treats shared Basic auth or an absent session as a user", async () => {
    const basic = request("/api/cli/me"); basic.headers.set("authorization", "Basic abc");
    expect((await handleInternalAuth(basic, env)).status).toBe(401);
    mocks.session.mockResolvedValue(null);
    expect((await handleInternalAuth(request("/api/cli/me", "GET", undefined, undefined, false), env)).status).toBe(401);
  });
  it("requires same-origin explicit browser approval and checks GitHub identity", async () => {
    const input = { user_code: "a".repeat(20), action: "approve" };
    expect((await handleInternalAuth(request("/api/cli/approve", "POST", input, "https://evil.example"), env)).status).toBe(403);
    expect((await handleInternalAuth(request("/api/cli/approve"), env)).status).toBe(404);
    expect(device.approve).not.toHaveBeenCalled();
    expect((await handleInternalAuth(request("/api/cli/approve", "POST", input, "https://example.com"), env)).status).toBe(200);
    expect(device.approve).toHaveBeenCalledWith(user, false);
    mocks.request.mockResolvedValue({ data: { id: 2, login: "bob" } });
    expect((await handleInternalAuth(request("/api/cli/approve", "POST", input, "https://example.com"), env)).status).toBe(401);
  });
  it("refuses refresh after removal from the allowlist and revokes issued credentials", async () => {
    const response = await handleInternalAuth(request("/api/cli/token", "POST", { grant_type: "refresh_token", refresh_token: token }), { ...env, INTERNAL_USERS: "" });
    expect(response.status).toBe(403);
    expect(device.revoke).toHaveBeenCalledWith("c".repeat(64));
  });
  it("bounds input and rate limits device issuance", async () => {
    expect((await handleInternalAuth(request("/api/cli/token", "POST", { value: "x".repeat(5000) }), env)).status).toBe(413);
    device.rateLimit.mockResolvedValueOnce(false);
    expect((await handleInternalAuth(request("/api/cli/device", "POST"), env)).status).toBe(429);
    expect(device.create).not.toHaveBeenCalled();
  });
});
