import { describe, expect, it, vi } from "vitest";
import { inferenceRoute, type GatewayDependencies } from "./gateway";
import { sparkEndpoint } from "./spark";
const model = { id: "spark/internal", upstream: "served-model", name: "Internal Spark", provider: "spark", contextLength: 8192, maxOutputTokens: 512, promptMicrosPerToken: 0, completionMicrosPerToken: 0, cacheReadMicrosPerToken: 0, cacheWriteMicrosPerToken: 0, requestMicros: 0 };
const settings = {
  enabled: true, models: JSON.stringify({ models: [], rate: { version: "public", markupBps: 2000 } }),
  spark: { enabled: true, users: "github:1", models: JSON.stringify([model]), baseUrl: "https://spark.example/v1", apiKey: "server-only-spark-key" },
};
function setup(userId = "github:1") {
  const recorder = { begin: vi.fn(async () => {}), observe: vi.fn(async () => {}), complete: vi.fn(async () => {}), rejected: vi.fn(async () => {}) };
  const upstream = vi.fn<typeof fetch>(async () => Response.json({ id: "spark-generation", choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
  const deps = { authorize: async () => ({ user: { id: userId }, workspace: { id: "org:9", login: "team", type: "Organization" as const } }), usage: async () => ({}), recorder: () => recorder, fetch: upstream } satisfies GatewayDependencies;
  return { recorder, upstream, deps };
}
const completion = (extra = {}) => new Request("https://outfitter/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: "Hello" }], ...extra }) });

describe("internal Spark entitlement", () => {
  it("hides Spark from public users even in an organization containing an internal user", async () => {
    const { deps, upstream, recorder } = setup("github:2");
    const result = await inferenceRoute(new Request("https://outfitter/v1/models"), settings, deps);
    expect(await result!.json()).toEqual({ object: "list", data: [] });
    expect((await inferenceRoute(completion(), settings, deps))?.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    expect(recorder.begin).not.toHaveBeenCalled();
  });
  it("does not accept workspace IDs as user entitlements", async () => {
    const { deps } = setup();
    const result = await inferenceRoute(completion(), { ...settings, spark: { ...settings.spark, users: "org:9,user:1,1" } }, deps);
    expect(result?.status).toBe(403);
  });
  it("requires the independent feature flag even for internal users", async () => {
    const { deps, upstream } = setup();
    expect((await inferenceRoute(completion(), { ...settings, spark: { ...settings.spark, enabled: false } }, deps))?.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("lists internal models at zero price and routes the configured served model only", async () => {
    const { deps, upstream, recorder } = setup();
    const listed = await inferenceRoute(new Request("https://outfitter/v1/models"), settings, deps);
    expect(await listed!.json()).toMatchObject({ data: [{ id: "spark/internal", pricing: { prompt: "0", completion: "0" } }] });
    const result = await inferenceRoute(completion(), settings, deps);
    expect(result?.status).toBe(200);
    expect(upstream).toHaveBeenCalledWith("https://spark.example/v1/chat/completions", expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer server-only-spark-key" }) }));
    const body = JSON.parse(String(upstream.mock.calls[0][1]?.body));
    expect(body.model).toBe("served-model");
    expect(body.provider).toBeUndefined();
    expect(recorder.begin).toHaveBeenCalledWith(expect.objectContaining({ provider: "spark", workspace: "org:9", userId: "github:1", maximumMicros: 0, rate: { version: "internal-spark-v1", markupBps: 0 } }));
    expect(recorder.observe).toHaveBeenCalledWith({ id: "spark-generation", cost: undefined, promptTokens: 5, completionTokens: 2 });
    expect(await result!.text()).not.toContain("server-only-spark-key");
  });
  it("rejects attempts to inject an endpoint or route unknown models", async () => {
    const { deps, upstream } = setup();
    expect((await inferenceRoute(completion({ base_url: "https://attacker" }), settings, deps))?.status).toBe(400);
    expect((await inferenceRoute(completion({ model: "spark/guess" }), settings, deps))?.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("never falls back between Spark and public inference", async () => {
    const { deps, upstream } = setup();
    upstream.mockRejectedValue(new Error("Spark unavailable"));
    expect((await inferenceRoute(completion(), settings, deps))?.status).toBe(503);
    expect(upstream).toHaveBeenCalledOnce();
    expect(String(upstream.mock.calls[0][0])).toContain("spark.example");
  });
  it("fails closed when Spark is accidentally listed as a public model", async () => {
    const { deps, upstream } = setup("github:2");
    const result = await inferenceRoute(completion(), { ...settings, models: JSON.stringify({ models: [model], rate: { version: "public", markupBps: 0 } }) }, deps);
    expect(result?.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("rejects charging internal traffic or an insecure endpoint", async () => {
    const { deps, upstream } = setup();
    expect((await inferenceRoute(completion(), { ...settings, spark: { ...settings.spark, models: JSON.stringify([{ ...model, requestMicros: 1 }]) } }, deps))?.status).toBe(503);
    for (const baseUrl of ["http://spark.example/v1", "https://u:p@spark.example/v1", "https://spark.example/v1?token=leak"]) expect(() => sparkEndpoint({ ...settings.spark, baseUrl })).toThrow();
    expect(upstream).not.toHaveBeenCalled();
  });
});
