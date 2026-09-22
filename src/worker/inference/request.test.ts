import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} } }));
import { InferenceRequest, type PendingRequest } from "./request";

function setup() {
  const data = new Map<string, unknown>();
  const billing = { reserve: vi.fn(async () => ({ status: "reserved" })), settle: vi.fn(async () => {}), release: vi.fn(async () => {}) };
  const storage = {
    get: vi.fn(async (key: string) => structuredClone(data.get(key))),
    put: vi.fn(async (key: string, value: unknown) => { data.set(key, structuredClone(value)); }),
    transaction: async (fn: (txn: unknown) => Promise<void>) => fn(storage),
    setAlarm: vi.fn(async () => {}), deleteAlarm: vi.fn(async () => {}),
  };
  const env = { BILLING_ACCOUNTS: { getByName: vi.fn(() => billing) }, OPENROUTER_API_KEY: "private" };
  const instance = new InferenceRequest({ storage } as unknown as DurableObjectState, env as unknown as Env);
  const input = { id: "request-1", workspace: "user:1", userId: "github:1", model: "example", maximumMicros: 100_000, rate: { version: "original", markupBps: 2000 } };
  return { instance, billing, storage, data, input, env, state: () => data.get("request") as PendingRequest };
}
afterEach(() => vi.unstubAllGlobals());

describe("durable generation reconciliation", () => {
  it("records internal Spark token usage without charging customers", async () => {
    const { instance, billing, input, state } = setup();
    await instance.begin({ ...input, provider: "spark", maximumMicros: 0 });
    await instance.observe({ id: "spark-id", promptTokens: 50, completionTokens: 7, cost: 99 });
    await instance.complete();
    expect(billing.settle).toHaveBeenCalledExactlyOnceWith("request-1", 0);
    expect(state()).toMatchObject({ provider: "spark", promptTokens: 50, completionTokens: 7, status: "settled", cost: 0 });
  });
  it("clears a zero-priced interrupted Spark hold without consulting OpenRouter", async () => {
    const { instance, billing, input, state } = setup();
    await instance.begin({ ...input, provider: "spark", maximumMicros: 0 });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await instance.alarm();
    expect(fetcher).not.toHaveBeenCalled();
    expect(billing.settle).toHaveBeenCalledWith("request-1", 0);
    expect(state().completionTokens).toBeUndefined();
  });
  it("persists the request before reserving and rejects reused dispatch IDs", async () => {
    const { instance, billing, storage, input } = setup();
    await instance.begin(input);
    expect(storage.put.mock.invocationCallOrder[0]).toBeLessThan(billing.reserve.mock.invocationCallOrder[0]);
    await expect(instance.begin(input)).rejects.toThrow("already dispatched");
    expect(billing.reserve).toHaveBeenCalledOnce();
  });
  it("retains missing generation usage and schedules recovery", async () => {
    const { instance, billing, input, storage, state } = setup();
    await instance.begin(input);
    await instance.complete();
    await instance.alarm();
    expect(billing.settle).not.toHaveBeenCalled();
    expect(billing.release).not.toHaveBeenCalled();
    expect(storage.setAlarm).toHaveBeenCalledTimes(2);
    expect(state().status).toBe("reserved");
  });
  it("settles the recorded final cost once using the original rate", async () => {
    const { instance, billing, input, state } = setup();
    await instance.begin(input);
    await instance.observe({ id: "gen-1", cost: 0.02 });
    await instance.complete();
    await instance.complete();
    expect(billing.settle).toHaveBeenCalledExactlyOnceWith("request-1", 24000);
    expect(state().status).toBe("settled");
  });
  it("recovers a disconnected generation after a retryable lookup failure", async () => {
    const { instance, billing, input, state } = setup();
    await instance.begin(input);
    await instance.observe({ id: "gen-1" });
    const upstream = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(Response.json({ data: { id: "gen-1", total_cost: 0.025, finish_reason: "stop" } }));
    vi.stubGlobal("fetch", upstream);
    await instance.alarm();
    expect(billing.settle).not.toHaveBeenCalled();
    await instance.alarm();
    expect(billing.settle).toHaveBeenCalledWith("request-1", 30000);
    expect(state().status).toBe("settled");
  });
  it.each([{ id: "gen-other", total_cost: 0.02, finish_reason: "stop" }, { id: "gen-1", finish_reason: "stop" }, { id: "gen-1", total_cost: 0.02 }])("does not settle mismatched, absent, or unfinished metadata", async (data) => {
    const { instance, billing, input } = setup();
    await instance.begin(input);
    await instance.observe({ id: "gen-1" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data })));
    await instance.alarm();
    expect(billing.settle).not.toHaveBeenCalled();
  });
  it("retries settlement after a crash/failure without discarding authoritative cost", async () => {
    const { instance, billing, input, state } = setup();
    await instance.begin(input);
    await instance.observe({ id: "gen-1", cost: 0.02 });
    billing.settle.mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(instance.complete()).rejects.toThrow();
    expect(state().status).toBe("reserved");
    await instance.alarm();
    expect(billing.settle).toHaveBeenCalledTimes(2);
    expect(state().status).toBe("settled");
  });
  it("does not release an ambiguous reservation RPC failure", async () => {
    const { instance, billing, input, state } = setup();
    billing.reserve.mockRejectedValue(new Error("RPC connection lost"));
    await expect(instance.begin(input)).rejects.toThrow();
    expect(state().status).toBe("pending");
    expect(billing.release).not.toHaveBeenCalled();
  });
  it("cancels recovery on an authoritative budget denial", async () => {
    const { instance, billing, input, state, storage } = setup();
    billing.reserve.mockRejectedValue(new Error("insufficient_credit"));
    await expect(instance.begin(input)).rejects.toThrow();
    expect(state().status).toBe("denied");
    expect(storage.deleteAlarm).toHaveBeenCalledOnce();
  });
  it("will not release a request once generation has begun", async () => {
    const { instance, billing, input } = setup();
    await instance.begin(input);
    await instance.observe({ id: "gen-1" });
    await expect(instance.rejected()).rejects.toThrow();
    expect(billing.release).not.toHaveBeenCalled();
  });
});
