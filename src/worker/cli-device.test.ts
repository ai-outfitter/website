import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class { constructor(public ctx: DurableObjectState, public env: Env) {} } }));
const { CliDevice } = await import("./cli-device");
const { digest, randomSecret } = await import("./cli-state");
const user = { id: "github:1" };
const workspace = { id: "user:1", login: "alice", type: "User" as const };
function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql = { exec(query: string, ...args: (string | number)[]) {
    const stmt = db.prepare(query);
    if (query.startsWith("SELECT")) return { toArray: () => stmt.all(...args) };
    stmt.run(...args); return { toArray: () => [] };
  } };
  const storage = { sql, setAlarm: vi.fn(async () => {}), deleteAll: vi.fn(async () => { db.exec("DROP TABLE IF EXISTS state; DROP TABLE IF EXISTS rate"); }), transactionSync: (fn: () => void) => { db.exec("BEGIN"); try { fn(); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; } } };
  const device = new CliDevice({ storage } as unknown as DurableObjectState, {} as Env);
  return { device, db, storage };
}
afterEach(() => vi.useRealTimers());
describe("CLI device credentials", () => {
  it("requires explicit approval, enforces polling, and issues the device grant only once", async () => {
    vi.useFakeTimers(); const { device } = fixture(); const secret = randomSecret();
    await device.create(secret);
    expect(await device.exchange(secret)).toEqual({ error: "authorization_pending" });
    expect(await device.exchange(secret)).toEqual({ error: "slow_down" });
    expect(device.approve(user, workspace)).toBe(true);
    expect(device.approve({ id: "github:2" }, workspace)).toBe(false);
    vi.advanceTimersByTime(10_001);
    const tokens = await device.exchange(secret);
    expect(tokens.access).toBeTruthy();
    expect(await device.exchange(secret)).toEqual({ error: "invalid_grant" });
    expect(await device.authenticate(tokens.access!)).toEqual({ user, workspace });
  });
  it("expires codes and rejects denial and incorrect secrets", async () => {
    vi.useFakeTimers(); const { device } = fixture(); const secret = randomSecret();
    await device.create(secret);
    expect(await device.exchange(randomSecret())).toEqual({ error: "invalid_grant" });
    device.approve(user, workspace, true);
    expect(await device.exchange(secret)).toEqual({ error: "access_denied" });
    vi.advanceTimersByTime(600_001);
    expect(device.approve(user, workspace)).toBe(false);
    expect(await device.exchange(secret)).toEqual({ error: "expired_token" });
  });
  it("stores only credential digests and atomically rotates refresh credentials", async () => {
    const { device, db } = fixture(); const secret = randomSecret();
    await device.create(secret); device.approve(user, workspace);
    const tokens = await device.exchange(secret);
    const stored = JSON.stringify(db.prepare("SELECT * FROM state").all());
    expect(stored).not.toContain(secret); expect(stored).not.toContain(tokens.access); expect(stored).not.toContain(tokens.refresh);
    expect(stored).toContain(await digest(secret));
    const results = await Promise.all([device.exchange(tokens.refresh!, true), device.exchange(tokens.refresh!, true)]);
    expect(results.filter((item) => item.access)).toHaveLength(1);
    expect(results.filter((item) => item.error === "invalid_grant")).toHaveLength(1);
    expect(await device.authenticate(tokens.access!)).toBeNull();
    const next = results.find((item) => item.access)!;
    expect(await device.revoke(next.access!)).toBe(true);
    expect(await device.authenticate(next.access!)).toBeNull();
    expect(await device.exchange(next.refresh!, true)).toEqual({ error: "invalid_grant" });
  });
  it("expires access independently and keeps an absolute refresh lifetime", async () => {
    vi.useFakeTimers(); const { device } = fixture(); const secret = randomSecret();
    await device.create(secret); device.approve(user, workspace);
    const tokens = await device.exchange(secret);
    vi.advanceTimersByTime(900_001);
    expect(await device.authenticate(tokens.access!)).toBeNull();
    const refreshed = await device.exchange(tokens.refresh!, true);
    expect(refreshed.access).toBeTruthy();
    vi.advanceTimersByTime(30 * 86400_000);
    expect(await device.exchange(refreshed.refresh!, true)).toEqual({ error: "invalid_grant" });
  });
  it("allows the last expired access credential to revoke without refreshing", async () => {
    vi.useFakeTimers(); const { device } = fixture(); const secret = randomSecret();
    await device.create(secret); device.approve(user, workspace);
    const tokens = await device.exchange(secret);
    vi.advanceTimersByTime(900_001);
    expect(await device.authenticate(tokens.access!)).toBeNull();
    expect(await device.revoke(randomSecret())).toBe(false);
    expect(await device.revoke(tokens.access!)).toBe(true);
    expect(await device.exchange(tokens.refresh!, true)).toEqual({ error: "invalid_grant" });
  });
  it("switches only with valid access and revokes the full device session", async () => {
    const { device } = fixture(); const secret = randomSecret();
    await device.create(secret); device.approve(user, workspace);
    const tokens = await device.exchange(secret);
    const org = { id: "org:2", login: "team", type: "Organization" as const };
    expect(await device.select("wrong", org)).toBe(false);
    expect(await device.select(tokens.access!, org)).toBe(true);
    expect((await device.authenticate(tokens.access!))?.workspace).toEqual(org);
  });
  it("keeps live refreshed sessions on stale alarms and recreates storage after expiry", async () => {
    vi.useFakeTimers(); const { device, storage } = fixture(); const secret = randomSecret();
    await device.create(secret); device.approve(user, workspace);
    const tokens = await device.exchange(secret);
    vi.advanceTimersByTime(600_001);
    await device.alarm();
    expect(storage.deleteAll).not.toHaveBeenCalled();
    expect(await device.authenticate(tokens.access!)).not.toBeNull();
    vi.advanceTimersByTime(30 * 86400_000);
    await device.alarm();
    expect(storage.deleteAll).toHaveBeenCalled();
    expect(await device.authenticate(tokens.access!)).toBeNull();
    expect(await device.exchange(tokens.refresh!, true)).toEqual({ error: "invalid_grant" });
  });
  it("rate limits initialization and clears rate state after its window", async () => {
    vi.useFakeTimers(); const { device } = fixture();
    for (let i = 0; i < 20; i++) expect(await device.rateLimit()).toBe(true);
    expect(await device.rateLimit()).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(await device.rateLimit()).toBe(true);
  });
});
