import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} } }));
const access = vi.hoisted(() => ({ verifyRepositoryScope: vi.fn() }));
vi.mock("./github", () => access);
const operator = vi.hoisted(() => ({ provisionResidents: vi.fn(), residentStatus: vi.fn(), sendTriage: vi.fn() }));
vi.mock("./operator", () => operator);
import { ResidentWorkspace } from "./workspace";
import { residentToken, parseResidentToken } from "./credentials";
import { sanitizedStatus, validateEnrollment, type Enrollment } from "./contracts";
const ready = { state: "ready", agents: [{ role: "project-manager", name: "Mira", ready: true }, { role: "engineer", name: "Eli", ready: true }] };
const enrollment: Enrollment = { workspace: { id: "org:12", login: "team", type: "Organization" }, installationId: 42, repositories: [{ id: 101, fullName: "team/app" }], projectManagerName: "Mira", engineerName: "Eli" };
const task = { id: "triage:org:12:101:9", repository: enrollment.repositories[0], issueNumber: 9, availableLabels: ["bug"], message: "Triage only" };
const secret = btoa("a".repeat(32));
function setup() {
  const values = new Map<string, unknown>();
  let tail = Promise.resolve();
  const baseStorage = {
    get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
    delete: async (key: string) => values.delete(key),
    list: async ({ prefix, limit = Infinity }: { prefix: string; limit?: number }) => new Map([...values].filter(([key]) => key.startsWith(prefix)).slice(0, limit)),
    setAlarm: vi.fn(async () => {}), deleteAlarm: vi.fn(async () => {}),
  };
  const storage = { ...baseStorage, transaction: <T>(fn: (txn: typeof baseStorage) => Promise<T>): Promise<T> => { const result = tail.then(() => fn(baseStorage)); tail = result.then(() => {}, () => {}); return result; } };
  const instance = new ResidentWorkspace({ storage } as unknown as DurableObjectState, { RESIDENTS_ENABLED: "true", RESIDENT_CREDENTIAL_SECRET: secret } as unknown as Env);
  return { instance, storage, values };
}
beforeEach(() => { vi.clearAllMocks(); access.verifyRepositoryScope.mockResolvedValue(undefined); operator.provisionResidents.mockResolvedValue(ready); operator.residentStatus.mockResolvedValue(ready); operator.sendTriage.mockResolvedValue(undefined); });

describe("resident workspace", () => {
  it("preserves stable credentials and desired revision on enrollment retries", async () => {
    const { instance } = setup();
    await instance.enroll(enrollment); const first = await instance.configuration();
    await instance.enroll(enrollment); const second = await instance.configuration();
    expect(second?.credentialVersion).toBe(first?.credentialVersion);
    expect(second?.revision).toBe(first?.revision);
    expect(JSON.stringify(await instance.status())).not.toContain(first!.credentialVersion);
  });
  it("authenticates role-bound tokens, revokes on disable and rotates on re-enable", async () => {
    const { instance } = setup(); await instance.enroll(enrollment);
    const config = (await instance.configuration())!;
    const token = await residentToken(secret, config.workspace.id, "project-manager", config.credentialVersion);
    expect(await instance.authenticate(token, "project-manager", config.credentialVersion)).toMatchObject({ workspace: enrollment.workspace });
    expect(await instance.authenticate(token, "engineer", config.credentialVersion)).toBeNull();
    await instance.disable(); expect(await instance.authenticate(token, "project-manager", config.credentialVersion)).toBeNull();
    await instance.enroll(enrollment); expect((await instance.configuration())?.credentialVersion).not.toBe(config.credentialVersion);
    expect(parseResidentToken(await residentToken(secret, config.workspace.id, "task", config.credentialVersion))).toBeNull();
  });
  it("deduplicates concurrent and repeated logical issue deliveries", async () => {
    const { instance } = setup(); await instance.enroll(enrollment);
    await Promise.all([instance.enqueue(42, task), instance.enqueue(42, task)]);
    await instance.enqueue(42, task); await instance.alarm();
    expect(operator.sendTriage).toHaveBeenCalledExactlyOnceWith(expect.anything(), "org:12", task);
  });
  it("retries an ambiguous delivery with exactly the same task identity", async () => {
    const { instance } = setup(); await instance.enroll(enrollment);
    operator.sendTriage.mockRejectedValueOnce(new Error("connection lost after acceptance"));
    expect(await instance.enqueue(42, task)).toBe("pending"); await instance.alarm();
    expect(operator.sendTriage).toHaveBeenCalledTimes(2);
    expect(operator.sendTriage.mock.calls[0][2]).toEqual(operator.sendTriage.mock.calls[1][2]);
  });
  it("blocks installation/repository substitution and disabled workspaces", async () => {
    const { instance } = setup(); await instance.enroll(enrollment);
    expect(await instance.enqueue(99, task)).toBe("ignored");
    expect(await instance.enqueue(42, { ...task, repository: { id: 102, fullName: "other/app" } })).toBe("ignored");
    await instance.disable(); expect(await instance.enqueue(42, task)).toBe("ignored");
    expect(operator.sendTriage).not.toHaveBeenCalled();
  });
  it("cancels queued work when its repository is removed", async () => {
    const { instance } = setup(); await instance.enroll(enrollment);
    operator.sendTriage.mockRejectedValueOnce(new Error("unavailable")); await instance.enqueue(42, task);
    await instance.enroll({ ...enrollment, repositories: [{ id: 102, fullName: "team/other" }] });
    await instance.alarm(); expect(operator.sendTriage).toHaveBeenCalledOnce();
  });
  it.each(["reenable", "installation"])("cancels an earlier enrollment's pending task after %s", async (change) => {
    const { instance } = setup(); await instance.enroll(enrollment);
    operator.sendTriage.mockRejectedValueOnce(new Error("unavailable")); await instance.enqueue(42, task);
    if (change === "reenable") { await instance.disable(); await instance.enroll(enrollment); }
    else await instance.enroll({ ...enrollment, installationId: 43 });
    await instance.alarm(); expect(operator.sendTriage).toHaveBeenCalledOnce();
  });
  it("rechecks GitHub installation/repository access on retries", async () => {
    const { instance } = setup(); await instance.enroll(enrollment);
    operator.sendTriage.mockRejectedValueOnce(new Error("unavailable")); await instance.enqueue(42, task);
    access.verifyRepositoryScope.mockRejectedValueOnce(new Error("installation suspended"));
    await instance.alarm(); expect(operator.sendTriage).toHaveBeenCalledOnce();
    expect(access.verifyRepositoryScope).toHaveBeenCalledTimes(2);
    await instance.alarm(); expect(operator.sendTriage).toHaveBeenCalledTimes(2);
  });
  it("serializes provisioning and never reports stale ready state", async () => {
    const { instance } = setup();
    let resolve!: (value: unknown) => void;
    operator.provisionResidents.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const first = instance.enroll(enrollment);
    await vi.waitFor(() => expect(operator.provisionResidents).toHaveBeenCalledOnce());
    await instance.enroll({ ...enrollment, engineerName: "Ada" });
    expect(await instance.status()).toMatchObject({ state: "provisioning" });
    resolve(ready); await first; await instance.alarm();
    expect(operator.provisionResidents).toHaveBeenCalledTimes(2);
    expect(operator.provisionResidents.mock.calls[1][1].engineerName).toBe("Ada");
  });
  it("does not accept shell syntax in display names or foreign repository names", () => {
    expect(() => validateEnrollment({ ...enrollment, engineerName: "$(printenv)" })).toThrow();
    expect(() => validateEnrollment({ ...enrollment, repositories: [{ id: 1, fullName: "other/app" }] })).toThrow();
  });
  it("strips operator diagnostics and rejects contradictory readiness", () => {
    expect(JSON.stringify(sanitizedStatus({ state: "failed", agents: ready.agents.map((agent) => ({ ...agent, ready: false, reason: "Bearer private-token" })) }))).not.toContain("private-token");
    expect(() => sanitizedStatus({ ...ready, agents: ready.agents.map((agent) => ({ ...agent, ready: false })) })).toThrow();
  });
});
