import { configuration, completionBody, InferenceError, maximumMicros, publicModel, record, type Rate } from "./models";
import { boundedText, observation, UsageParser, type GenerationObservation } from "./stream";

export interface Identity {
  user: { id: string; email?: string };
  workspace: { id: string; login: string; type: "User" | "Organization" };
}
export interface RequestRecord {
  id: string; workspace: string; userId: string; model: string; maximumMicros: number; rate: Rate;
}
export interface Recorder {
  begin(value: RequestRecord): Promise<unknown>;
  observe(value: GenerationObservation): Promise<unknown>;
  complete(): Promise<unknown>;
  rejected(): Promise<unknown>;
}
export interface GatewayDependencies {
  authorize(request: Request): Promise<Identity>;
  recorder(id: string): Recorder;
  usage(workspace: string): Promise<unknown>;
  fetch: typeof fetch;
}
export interface GatewayConfiguration {
  enabled: boolean;
  models: string;
  openRouterKey?: string;
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
export const failure = (code: string, status: number, message: string) => json({ error: { code, message } }, status);

export async function inferenceRoute(request: Request, settings: GatewayConfiguration, deps: GatewayDependencies): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!["/v1/models", "/v1/chat/completions", "/api/cli/usage"].includes(path)) return null;
  if (!settings.enabled) return failure("unavailable", 503, "Hosted inference is not enabled");
  if (request.method !== (path === "/v1/chat/completions" ? "POST" : "GET")) return failure("method_not_allowed", 405, "Method not allowed");
  try {
    const identity = await deps.authorize(request);
    if (path === "/api/cli/usage") {
      const usage = await deps.usage(identity.workspace.id);
      if (!record(usage)) throw new Error("Usage unavailable");
      return json({ ...usage, workspace: identity.workspace, currency: "usd" });
    }
    const config = configuration(settings.models);
    const rate = config.accounts?.[identity.workspace.id] ?? config.rate;
    if (path === "/v1/models") return json({ object: "list", data: config.models.map((model) => publicModel(model, rate)) });
    let input: unknown;
    try { input = JSON.parse(await boundedText(request, 262_144)); }
    catch { throw new InferenceError("invalid_request", 400, "Provide a JSON body no larger than 256 KiB"); }
    const model = config.models.find((item) => record(input) && item.id === input.model);
    if (!model) throw new InferenceError("model_not_allowed", 403, "Model is not available to this account");
    const { body, output } = completionBody(input, model);
    if (!settings.openRouterKey) return failure("unavailable", 503, "Inference provider unavailable");
    const id = crypto.randomUUID();
    const recorder = deps.recorder(id);
    await recorder.begin({ id, workspace: identity.workspace.id, userId: identity.user.id, model: model.id, maximumMicros: maximumMicros(model, output, rate), rate });
    // Once dispatched, transport errors are ambiguous: leave the hold for reconciliation.
    const upstream = await deps.fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${settings.openRouterKey}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(300_000), redirect: "error",
    });
    if (!upstream.ok) {
      // Provider rejection before generation is authoritative for these statuses only.
      if ([400, 401, 402, 403, 404, 422, 429].includes(upstream.status)) await recorder.rejected();
      await upstream.body?.cancel();
      return failure(upstream.status === 429 ? "capacity_limit" : "upstream_unavailable", upstream.status === 429 ? 429 : 502, "Inference provider could not accept the request");
    }
    const headers = { "cache-control": "no-store", "x-outfitter-request-id": id };
    if (!body.stream) {
      const value: unknown = JSON.parse(await boundedText(upstream, 8_388_608));
      await recorder.observe(observation(value));
      await recorder.complete();
      return json(value);
    }
    if (!upstream.body || !upstream.headers.get("content-type")?.includes("text/event-stream")) throw new Error("Invalid upstream stream");
    const reader = upstream.body.getReader();
    const parser = new UsageParser(async (value) => { await recorder.observe(value); });
    let ended = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (ended) return;
        try {
          const { done, value } = await reader.read();
          if (done) {
            ended = true;
            await parser.push(new Uint8Array(), true);
            await recorder.complete();
            controller.close();
            reader.releaseLock();
          } else {
            // Persist generation IDs and costs before forwarding their event to the caller.
            await parser.push(value);
            controller.enqueue(value);
          }
        } catch {
          ended = true;
          await reader.cancel().catch(() => {});
          reader.releaseLock();
          controller.error(new Error("Inference stream interrupted; usage will be reconciled"));
        }
      },
      async cancel() {
        ended = true;
        await reader.cancel();
        // Durable alarm owns recovery; cancellation never clears a financial hold.
      },
    });
    return new Response(stream, { headers: { ...headers, "content-type": "text/event-stream" } });
  } catch (error) {
    if (error instanceof InferenceError) return failure(error.code, error.status, error.message);
    if (error instanceof Response) return failure("unauthorized", error.status, "Workspace access denied");
    const message = error instanceof Error ? error.message : "";
    if (/insufficient_credit|paid_limit_reached/.test(message)) return failure("insufficient_credit", 402, "Workspace credit or paid usage limit exhausted");
    return failure("unavailable", 503, "Inference temporarily unavailable");
  }
}
