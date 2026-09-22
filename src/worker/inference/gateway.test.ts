import { describe, expect, it, vi } from "vitest";
import { inferenceRoute, type GatewayDependencies, type Recorder } from "./gateway";
import { configuration, maximumMicros, chargeMicros, type HostedModel } from "./models";
import { UsageParser } from "./stream";

const model: HostedModel = { id: "example/model", upstream: "example/model", name: "Example", provider: "example", contextLength: 10_000, maxOutputTokens: 100, promptMicrosPerToken: 1, completionMicrosPerToken: 2, cacheReadMicrosPerToken: 0.5, cacheWriteMicrosPerToken: 1.25, requestMicros: 100 };
const rate = { version: "2026-09", markupBps: 2000 };
const settings = { enabled: true, models: JSON.stringify({ models: [model], rate }), openRouterKey: "server-only-test" };
const identity = { user: { id: "github:1" }, workspace: { id: "user:1", login: "alice", type: "User" as const } };
function setup(response = Response.json({ id: "gen-1", choices: [], usage: { cost: 0.002 } })) {
  const recorder = { begin: vi.fn(async () => {}), observe: vi.fn(async () => {}), complete: vi.fn(async () => {}), rejected: vi.fn(async () => {}) } satisfies Recorder;
  const fetcher = vi.fn<typeof fetch>(async () => response);
  const deps = { authorize: vi.fn(async () => identity), recorder: () => recorder, fetch: fetcher, usage: vi.fn(async () => ({ paidMicros: 42, paidEnabled: false })) } satisfies GatewayDependencies;
  return { recorder, fetcher, deps };
}
const request = (body: Record<string, unknown> = {}) => new Request("https://test/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: "hi" }], ...body }) });

describe("hosted inference gateway", () => {
  it("fails closed before authentication when disabled", async () => {
    const { deps } = setup();
    expect((await inferenceRoute(request(), { ...settings, enabled: false }, deps))?.status).toBe(503);
    expect(deps.authorize).not.toHaveBeenCalled();
  });
  it("reserves the authenticated workspace before upstream and snapshots its markup", async () => {
    const { deps, recorder, fetcher } = setup();
    const result = await inferenceRoute(request(), settings, deps);
    expect(result?.status).toBe(200);
    expect(recorder.begin).toHaveBeenCalledWith(expect.objectContaining({ workspace: "user:1", userId: "github:1", maximumMicros: 33360, rate }));
    expect(recorder.begin.mock.invocationCallOrder[0]).toBeLessThan(fetcher.mock.invocationCallOrder[0]);
    const sent = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(sent.provider).toEqual({ only: ["example"], allow_fallbacks: false, require_parameters: true, max_price: { prompt: 1, completion: 2, request: 0.0001 } });
    expect(recorder.observe).toHaveBeenCalledWith({ id: "gen-1", cost: 0.002 });
    expect(recorder.complete).toHaveBeenCalledOnce();
    expect(await result!.text()).not.toContain("server-only-test");
  });
  it.each([{ model: "unknown" }, { provider: { only: ["evil"] } }, { plugins: [{ id: "web" }] }, { n: 50 }, { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://remote" } }] }] }, { max_tokens: 101 }, { max_tokens: 10, max_completion_tokens: 10 }])("rejects unauthorized cost modes before reservation: %j", async (body) => {
    const { deps, recorder, fetcher } = setup();
    expect((await inferenceRoute(request(body), settings, deps))!.status).toBeGreaterThanOrEqual(400);
    expect(recorder.begin).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("returns account budget denial without dispatch", async () => {
    const { deps, recorder, fetcher } = setup();
    recorder.begin.mockRejectedValue(new Error("paid_limit_reached"));
    expect((await inferenceRoute(request(), settings, deps))?.status).toBe(402);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([400, 401, 402, 403, 404, 422, 429])("releases authoritative pre-generation rejection %i", async (status) => {
    const { deps, recorder } = setup(new Response("upstream secret details", { status }));
    const result = await inferenceRoute(request(), settings, deps);
    expect(recorder.rejected).toHaveBeenCalledOnce();
    expect(await result!.text()).not.toContain("secret details");
  });
  it.each([500, 502, 503])("retains ambiguous upstream failure %i", async (status) => {
    const { deps, recorder } = setup(new Response("failure", { status }));
    expect((await inferenceRoute(request(), settings, deps))?.status).toBe(502);
    expect(recorder.rejected).not.toHaveBeenCalled();
  });
  it("retains network failures without making up zero usage", async () => {
    const { deps, recorder, fetcher } = setup();
    fetcher.mockRejectedValue(new Error("timeout"));
    expect((await inferenceRoute(request(), settings, deps))?.status).toBe(503);
    expect(recorder.complete).not.toHaveBeenCalled();
    expect(recorder.rejected).not.toHaveBeenCalled();
  });
  it("keeps generation ID and missing cost distinguishable", async () => {
    const { deps, recorder } = setup(Response.json({ id: "gen-1", choices: [] }));
    await inferenceRoute(request(), settings, deps);
    expect(recorder.observe).toHaveBeenCalledWith({ id: "gen-1", cost: undefined });
  });
  it("streams fragmented UTF-8, CRLF and function calls without changing their bytes", async () => {
    const text = 'data: {"id":"gen-1","choices":[{"delta":{"tool_calls":[{"function":{"name":"read","arguments":"café"}}]}}]}\r\n\r\ndata: {"id":"gen-1","usage":{"cost":0.002}}\n\ndata: [DONE]\n\n';
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    const { deps, recorder } = setup(new Response(new ReadableStream({ pull(controller) { if (offset === bytes.length) controller.close(); else controller.enqueue(bytes.slice(offset, ++offset)); } }), { headers: { "content-type": "text/event-stream" } }));
    const result = await inferenceRoute(request({ stream: true }), settings, deps);
    expect(await result!.text()).toBe(text);
    expect(recorder.observe).toHaveBeenCalledWith({ id: "gen-1", cost: 0.002 });
    expect(recorder.complete).toHaveBeenCalledOnce();
  });
  it("persists generation before delivering a chunk and retains hold on cancellation", async () => {
    let sent = false;
    const cancel = vi.fn();
    const { deps, recorder } = setup(new Response(new ReadableStream({ pull(controller) { if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode('data: {"id":"gen-disconnect"}\n\n')); } }, cancel }), { headers: { "content-type": "text/event-stream" } }));
    const result = await inferenceRoute(request({ stream: true }), settings, deps);
    const reader = result!.body!.getReader();
    await reader.read();
    expect(recorder.observe).toHaveBeenCalledWith({ id: "gen-disconnect", cost: undefined });
    await reader.cancel();
    expect(cancel).toHaveBeenCalled();
    expect(recorder.rejected).not.toHaveBeenCalled();
    expect(recorder.complete).not.toHaveBeenCalled();
  });
  it("lists marked-up prices and uses per-account overrides", async () => {
    const { deps } = setup();
    const result = await inferenceRoute(new Request("https://test/v1/models"), { ...settings, models: JSON.stringify({ models: [model], rate, accounts: { "user:1": { version: "partner", markupBps: 0 } } }) }, deps);
    expect(await result!.json()).toMatchObject({ data: [{ pricing: { prompt: "0.000001" } }] });
  });
  it("uses only the authenticated workspace for usage", async () => {
    const { deps } = setup();
    const result = await inferenceRoute(new Request("https://test/api/cli/usage?workspace=org:999"), settings, deps);
    expect(deps.usage).toHaveBeenCalledWith("user:1");
    expect(await result!.json()).toMatchObject({ workspace: identity.workspace });
  });
  it("fails closed on authentication and does not leak error text", async () => {
    const { deps, fetcher } = setup();
    deps.authorize.mockRejectedValue(new Response("private", { status: 403 }));
    expect((await inferenceRoute(request(), settings, deps))?.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("price and stream validation", () => {
  it("requires all cache and request price ceilings and rejects duplicate model IDs", () => {
    expect(() => configuration(JSON.stringify({ models: [{ ...model, cacheWriteMicrosPerToken: undefined }], rate }))).toThrow();
    expect(() => configuration(JSON.stringify({ models: [model, model], rate }))).toThrow();
    expect(maximumMicros(model, 100, rate)).toBe(33360);
    expect(chargeMicros(0.0000001, rate)).toBe(1);
    expect(() => chargeMicros(Number.NaN, rate)).toThrow();
  });
  it("bounds multiline SSE events", async () => {
    const parser = new UsageParser(async () => {});
    const chunk = new TextEncoder().encode(`data: ${"x".repeat(800_000)}\n`);
    await parser.push(chunk);
    await expect(parser.push(chunk)).rejects.toThrow("too large");
  });
});
