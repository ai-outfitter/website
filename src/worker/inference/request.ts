import { DurableObject } from "cloudflare:workers";
import { chargeMicros, record } from "./models";
import { boundedText, type GenerationObservation } from "./stream";
import type { RequestRecord } from "./gateway";

export interface PendingRequest extends RequestRecord {
  status: "pending" | "reserved" | "settled" | "denied";
  generationId?: string;
  cost?: number;
  attempts: number;
}

/** One durable reconciliation record per generation, containing no prompts or credentials. */
export class InferenceRequest extends DurableObject<Env> {
  async begin(input: RequestRecord) {
    // Persist before asking the account to reserve, and never dispatch the same request twice.
    const state: PendingRequest = { ...input, status: "pending", attempts: 0 };
    await this.ctx.storage.transaction(async (txn) => {
      if (await txn.get("request")) throw new Error("Request already dispatched");
      await txn.put("request", state);
    });
      await this.ctx.storage.setAlarm(Date.now() + 600_000);
      try {
        const result = await this.env.BILLING_ACCOUNTS.getByName(input.workspace).reserve(input.workspace, {
          id: input.id, maximumMicros: input.maximumMicros, userId: input.userId, model: input.model, rateVersion: input.rate.version,
        });
        if (result.status !== "reserved") throw new Error("Request already settled");
        await this.ctx.storage.put("request", { ...state, status: "reserved" });
      } catch (error) {
        // An RPC transport failure can mean the account committed a reservation. Keep it visible.
        if (/insufficient_credit|paid_limit_reached/.test(error instanceof Error ? error.message : "")) {
          await this.ctx.storage.put("request", { ...state, status: "denied" });
          await this.ctx.storage.deleteAlarm();
        }
        throw error;
      }
  }

  async observe(value: GenerationObservation) {
    await this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get<PendingRequest>("request");
      if (!state || state.status === "settled" || state.status === "denied") return;
      if (value.id && state.generationId && value.id !== state.generationId) throw new Error("Generation changed during response");
      if (value.id) state.generationId = value.id;
      if (value.cost !== undefined) {
        chargeMicros(value.cost, state.rate);
        state.cost = value.cost;
      }
      await txn.put("request", state);
    });
  }

  async complete() {
    const state = await this.ctx.storage.get<PendingRequest>("request");
    if (!state || state.status === "settled" || state.status === "denied") return;
    if (state.cost === undefined) return; // Missing accounting is unresolved, never free.
    await this.env.BILLING_ACCOUNTS.getByName(state.workspace).settle(state.id, chargeMicros(state.cost, state.rate));
    await this.ctx.storage.put("request", { ...state, status: "settled" });
    await this.ctx.storage.deleteAlarm();
  }

  async rejected() {
    const state = await this.ctx.storage.get<PendingRequest>("request");
    if (!state || state.status === "settled" || state.status === "denied") return;
    if (state.generationId || state.cost !== undefined) throw new Error("Generation cannot be released");
    await this.env.BILLING_ACCOUNTS.getByName(state.workspace).release(state.id);
    await this.ctx.storage.put("request", { ...state, status: "settled", cost: 0 });
    await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    const state = await this.ctx.storage.get<PendingRequest>("request");
    if (!state || state.status === "settled" || state.status === "denied") return;
    // Schedule first so worker eviction, network failure, and exhausted platform retries remain recoverable.
    await this.ctx.storage.setAlarm(Date.now() + (state.attempts < 60 ? 60_000 : 86_400_000));
    await this.ctx.storage.put("request", { ...state, attempts: state.attempts + 1 });
    try {
      if (state.cost !== undefined) { await this.complete(); return; }
      if (!state.generationId || !this.env.OPENROUTER_API_KEY) {
        console.warn(JSON.stringify({ event: "inference_reconciliation_required", requestId: state.id, reason: "missing_generation" }));
        return;
      }
      const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(state.generationId)}`, {
        headers: { authorization: `Bearer ${this.env.OPENROUTER_API_KEY}` }, signal: AbortSignal.timeout(15_000), redirect: "error",
      });
      if (!response.ok) { await response.body?.cancel(); return; }
      const result: unknown = JSON.parse(await boundedText(response, 65_536));
      if (!record(result) || !record(result.data) || result.data.id !== state.generationId || typeof result.data.total_cost !== "number" || (typeof result.data.finish_reason !== "string" && result.data.cancelled !== true)) return;
      await this.observe({ id: state.generationId, cost: result.data.total_cost });
      await this.complete();
    } catch {
      console.warn(JSON.stringify({ event: "inference_reconciliation_required", requestId: state.id, reason: "retry" }));
    }
  }
}
