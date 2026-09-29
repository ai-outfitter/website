import { DurableObject } from "cloudflare:workers";
import { authenticateInternal } from "./internal-auth";
import { limitedText } from "./billing/routes";

const MODEL = { id: "spark/glm-5.3-flash", object: "model", owned_by: "outfitter", name: "DGX Spark GLM-5.3 Flash", context_length: 131072, max_output_tokens: 4096 };
const reply = (error: string, status: number) => Response.json({ error: { message: error, type: "outfitter_error" } }, { status, headers: { "cache-control": "no-store" } });

export class InternalInferenceLimit extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, user TEXT NOT NULL, expires INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS requests (user TEXT NOT NULL, minute INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(user, minute))");
  }
  acquire(user: string): string | null {
    const sql = this.ctx.storage.sql, now = Date.now(), minute = Math.floor(now / 60000);
    return this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM leases WHERE expires <= ?", now);
      sql.exec("DELETE FROM requests WHERE minute < ?", minute);
      const total = sql.exec<{ n: number }>("SELECT count(*) AS n FROM leases").one().n;
      const personal = sql.exec<{ n: number }>("SELECT count(*) AS n FROM leases WHERE user = ?", user).one().n;
      const used = sql.exec<{ count: number }>("SELECT count FROM requests WHERE user = ? AND minute = ?", user, minute).toArray()[0]?.count ?? 0;
      if (total >= 4 || personal >= 2 || used >= 20) return null;
      const id = crypto.randomUUID();
      sql.exec("INSERT INTO leases VALUES (?, ?, ?)", id, user, now + 185000);
      sql.exec("INSERT INTO requests VALUES (?, ?, 1) ON CONFLICT(user, minute) DO UPDATE SET count = count + 1", user, minute);
      return id;
    });
  }
  release(id: string) { this.ctx.storage.sql.exec("DELETE FROM leases WHERE id = ?", id); }
}

export async function internalInference(request: Request, env: Env): Promise<Response> {
  let lease: string | null = null;
  let stage = "authorization";
  const limit = env.INTERNAL_INFERENCE_LIMIT.getByName("spark");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  const cleanup = async () => { clearTimeout(timeout); if (lease) { const id = lease; lease = null; await limit.release(id); } };
  try {
    const { user } = await authenticateInternal(request, env);
    const path = new URL(request.url).pathname;
    if (path === "/v1/models") return request.method === "GET"
      ? Response.json({ object: "list", data: [MODEL] }, { headers: { "cache-control": "no-store" } }) : reply("Method not allowed", 405);
    if (path !== "/v1/chat/completions") return reply("Not found", 404);
    if (request.method !== "POST") return reply("Method not allowed", 405);
    // Browser sessions require exact-origin POSTs; bearer clients do not use browser cookies.
    if (!request.headers.get("authorization")?.match(/^Bearer /i) && request.headers.get("origin") !== env.BETTER_AUTH_URL) return reply("Invalid origin", 403);
    let input: Record<string, unknown>;
    try { input = JSON.parse(await limitedText(request, 262144)); } catch { return reply("Invalid or oversized request", 400); }
    if (!input || input.model !== MODEL.id) return reply("Model unavailable", 404);
    if (!Array.isArray(input.messages) || !input.messages.length || (input.stream !== undefined && typeof input.stream !== "boolean")) return reply("Invalid messages or stream", 400);
    if ((input.n !== undefined && input.n !== 1) || input.best_of !== undefined) return reply("Multiple generations are not supported", 400);
    const maximum = input.max_tokens ?? input.max_completion_tokens ?? MODEL.max_output_tokens;
    if (!Number.isSafeInteger(maximum) || Number(maximum) < 1 || Number(maximum) > MODEL.max_output_tokens) return reply("Invalid output limit", 400);
    if (!env.SPARK_BASE_URL || !env.SPARK_AUTHORIZATION) return reply("Spark unavailable", 503);
    const base = new URL(env.SPARK_BASE_URL);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || !base.pathname.endsWith("/v1")) return reply("Spark unavailable", 503);
    stage = "reservation";
    lease = await limit.acquire(user.id);
    if (!lease) return reply("Request limit reached; retry shortly", 429);
    timeout = setTimeout(() => abort.abort(), 180000);
    request.signal.addEventListener("abort", () => abort.abort(), { once: true });
    if (request.signal.aborted) { abort.abort(); await cleanup(); return reply("Request cancelled", 499); }
    const payload: Record<string, unknown> = { model: env.SPARK_MODEL ?? "GLM-5.3-Flash-EXL3", max_tokens: maximum };
    for (const key of ["messages", "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls", "temperature", "top_p", "stop", "seed", "frequency_penalty", "presence_penalty"]) {
      if (input[key] !== undefined) payload[key] = input[key];
    }
    stage = "upstream";
    const upstream = await fetch(`${base.href}/chat/completions`, {
      method: "POST", redirect: "manual", signal: abort.signal,
      headers: { authorization: env.SPARK_AUTHORIZATION, "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    if (!upstream.ok || !upstream.body) { await upstream.body?.cancel(); await cleanup(); return reply("Spark request failed", 502); }
    const reader = upstream.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try { const value = await reader.read(); if (value.done) { await cleanup(); controller.close(); } else controller.enqueue(value.value); }
        catch (error) { await cleanup(); controller.error(error); }
      },
      async cancel(reason) { abort.abort(); try { await reader.cancel(reason); } finally { await cleanup(); } },
    });
    return new Response(stream, { headers: { "content-type": input.stream ? "text/event-stream" : "application/json", "cache-control": "no-store" } });
  } catch (error) {
    abort.abort(); await cleanup();
    if (error instanceof Response) return error;
    console.error("Internal inference failure", { stage, name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : "unknown" });
    return reply("Inference temporarily unavailable", 503);
  }
}
