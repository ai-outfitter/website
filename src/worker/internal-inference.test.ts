import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class { constructor(public ctx: DurableObjectState, public env: Env) {} } }));
const auth = vi.hoisted(() => ({ authenticate: vi.fn(async () => ({ user: { id: "github:1", login: "alice" } })) }));
vi.mock("./internal-auth", () => ({ authenticateInternal: auth.authenticate }));
import { InternalInferenceLimit, internalInference } from "./internal-inference";
const acquire = vi.fn(async () => "lease");
const release = vi.fn(async () => {});
const env = { BETTER_AUTH_URL: "https://beta.ai-outfitter.com", SPARK_BASE_URL: "https://spark.example/v1", SPARK_AUTHORIZATION: "Basic server-only", INTERNAL_INFERENCE_LIMIT: { getByName: () => ({ acquire, release }) } } as unknown as Env;
const request = (extra = {}) => new Request('https://beta.ai-outfitter.com/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer client-only' }, body: JSON.stringify({ model: 'spark/glm-5.3-flash', stream: true, messages: [{ role: 'user', content: 'hello' }], ...extra }) });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); release.mockClear(); acquire.mockClear(); });
describe('internal Spark gateway', () => {
  it('requires authorization before discovery or invocation and rejects guessed models', async () => {
    auth.authenticate.mockRejectedValueOnce(new Response('denied', { status: 403 }));
    expect((await internalInference(new Request('https://beta.ai-outfitter.com/v1/models'), env)).status).toBe(403);
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    expect((await internalInference(request({ model: 'other' }), env)).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled();
  });
  it('streams tool calls unchanged, uses only the server credential, and releases the lease', async () => {
    const data = 'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"test","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n';
    const upstream = vi.fn(async () => new Response(data)); vi.stubGlobal('fetch', upstream);
    const tools = [{ type: 'function', function: { name: 'test', parameters: { type: 'object' } } }];
    const response = await internalInference(request({ tools }), env);
    expect(await response.text()).toBe(data); expect(release).toHaveBeenCalledWith('lease');
    const [url, options] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://spark.example/v1/chat/completions');
    expect(options.headers).toMatchObject({ authorization: 'Basic server-only' });
    expect(JSON.parse(String(options.body))).toMatchObject({ model: 'GLM-5.3-Flash-EXL3', tools, max_tokens: 4096 });
  });
  it('releases capacity when upstream fails or the client cancels', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream details', { status: 500 })));
    const failed = await internalInference(request(), env); expect(failed.status).toBe(502); expect(await failed.text()).not.toContain('upstream details'); expect(release).toHaveBeenCalled();
    release.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ pull() {} }))));
    const response = await internalInference(request(), env); await response.body!.cancel(); expect(release).toHaveBeenCalled();
  });
  it('enforces global and per-user concurrency with recoverable expired leases', () => {
    const db = new DatabaseSync(':memory:');
    const storage = { sql: { exec(query: string, ...args: (string | number)[]) { const statement = db.prepare(query); if (query.startsWith('SELECT')) { const rows = statement.all(...args); return { one: () => rows[0], toArray: () => rows }; } statement.run(...args); return { toArray: () => [] }; } }, transactionSync<T>(fn: () => T) { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } } };
    const limit = new InternalInferenceLimit({ storage } as unknown as DurableObjectState, env);
    const first = limit.acquire('a')!; expect(first).toBeTruthy(); expect(limit.acquire('a')).toBeTruthy(); expect(limit.acquire('a')).toBeNull();
    expect(limit.acquire('b')).toBeTruthy(); expect(limit.acquire('b')).toBeTruthy(); expect(limit.acquire('c')).toBeNull();
    limit.release(first); expect(limit.acquire('c')).toBeTruthy();
    db.exec('UPDATE leases SET expires=0'); expect(limit.acquire('d')).toBeTruthy(); db.close();
  });
});
