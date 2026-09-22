/** All money is USD. Rates are server-owned ceilings, never supplied by callers. */
export interface HostedModel {
  id: string;
  upstream: string;
  name: string;
  contextLength: number;
  maxOutputTokens: number;
  provider: string;
  promptMicrosPerToken: number;
  completionMicrosPerToken: number;
  cacheReadMicrosPerToken: number;
  cacheWriteMicrosPerToken: number;
  requestMicros: number;
}
export interface Rate { version: string; markupBps: number }
export interface ModelConfiguration { models: HostedModel[]; rate: Rate; accounts?: Record<string, Rate> }
export class InferenceError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}
export const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const positiveInteger = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value > 0;
function validateRate(value: unknown): asserts value is Rate {
  if (!record(value) || typeof value.version !== "string" || !/^[\w.-]{1,80}$/.test(value.version) || !finite(value.markupBps) || !Number.isSafeInteger(value.markupBps) || value.markupBps > 100_000) throw new Error("Invalid inference rate configuration");
}
export function configuration(raw: string): ModelConfiguration {
  const config: unknown = JSON.parse(raw);
  if (!record(config) || !Array.isArray(config.models)) throw new Error("Invalid inference configuration");
  validateRate(config.rate);
  const ids = new Set<string>();
  for (const model of config.models) {
    if (!record(model) || typeof model.id !== "string" || !/^[\w./-]{1,160}$/.test(model.id) || ids.has(model.id) || typeof model.upstream !== "string" || !/^[\w./-]{1,160}$/.test(model.upstream) || typeof model.name !== "string" || !model.name || typeof model.provider !== "string" || !model.provider || !positiveInteger(model.contextLength) || model.contextLength > 1_000_000 || !positiveInteger(model.maxOutputTokens) || model.maxOutputTokens >= model.contextLength) throw new Error("Invalid inference model configuration");
    for (const key of ["promptMicrosPerToken", "completionMicrosPerToken", "cacheReadMicrosPerToken", "cacheWriteMicrosPerToken", "requestMicros"]) if (!finite(model[key])) throw new Error("Missing inference price ceiling");
    ids.add(model.id);
  }
  if (config.accounts !== undefined) {
    if (!record(config.accounts)) throw new Error("Invalid account rates");
    for (const [id, rate] of Object.entries(config.accounts)) {
      if (!/^(user|org):[1-9]\d*$/.test(id)) throw new Error("Invalid rate account");
      validateRate(rate);
    }
  }
  return config as unknown as ModelConfiguration;
}
export function chargeMicros(costUsd: number, rate: Rate) {
  if (!finite(costUsd)) throw new Error("Missing authoritative generation cost");
  const value = Math.ceil(costUsd * 1_000_000 * (10_000 + rate.markupBps) / 10_000);
  if (!Number.isSafeInteger(value) || value > 1e12) throw new Error("Invalid generation cost");
  return value;
}
export function maximumMicros(model: HostedModel, output: number, rate: Rate) {
  // Reserve the entire context, including worst-case cache read/write and request charges.
  // This intentionally over-reserves rather than relying on a tokenizer approximation.
  const input = model.promptMicrosPerToken + model.cacheReadMicrosPerToken + model.cacheWriteMicrosPerToken;
  return chargeMicros((model.contextLength * input + output * model.completionMicrosPerToken + model.requestMicros) / 1_000_000, rate);
}
export function publicModel(model: HostedModel, rate: Rate) {
  const multiplier = (10_000 + rate.markupBps) / 10_000 / 1_000_000;
  return { id: model.id, object: "model", name: model.name, context_length: model.contextLength, max_output_tokens: model.maxOutputTokens, pricing: { prompt: String(model.promptMicrosPerToken * multiplier), completion: String(model.completionMicrosPerToken * multiplier) } };
}

export function completionBody(input: unknown, model: HostedModel) {
  if (!record(input)) throw new InferenceError("invalid_request", 400, "A JSON request is required");
  const allowed = new Set(["model", "messages", "tools", "tool_choice", "stream", "stream_options", "max_tokens", "max_completion_tokens", "temperature", "top_p", "stop", "parallel_tool_calls", "reasoning_effort"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new InferenceError("invalid_request", 400, "Unsupported inference option");
  if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 1000) throw new InferenceError("invalid_request", 400, "Messages are required");
  for (const message of input.messages) {
    if (!record(message) || !["system", "developer", "user", "assistant", "tool"].includes(String(message.role)) || Object.keys(message).some((key) => !["role", "content", "name", "tool_calls", "tool_call_id", "reasoning_details", "reasoning_content"].includes(key))) throw new InferenceError("invalid_request", 400, "Unsupported message");
    if (message.content !== null && typeof message.content !== "string") {
      if (!Array.isArray(message.content) || !message.content.every((part: unknown) => record(part) && part.type === "text" && typeof part.text === "string" && Object.keys(part).every((key) => ["type", "text"].includes(key)))) throw new InferenceError("invalid_request", 400, "Only text and tool messages are supported");
    }
    if (message.reasoning_content !== undefined && (message.role !== "assistant" || typeof message.reasoning_content !== "string")) throw new InferenceError("invalid_request", 400, "Invalid reasoning history");
    if (message.reasoning_details !== undefined && (message.role !== "assistant" || !Array.isArray(message.reasoning_details) || !message.reasoning_details.every((detail: unknown) => record(detail) && Object.entries(detail).every(([key, value]) => ["type", "format", "index", "text", "summary", "data", "signature", "id"].includes(key) && (typeof value === "string" || typeof value === "number" || value === null))))) throw new InferenceError("invalid_request", 400, "Invalid reasoning history");
    if (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || !message.tool_calls.every((call: unknown) => record(call) && call.type === "function" && typeof call.id === "string" && record(call.function) && typeof call.function.name === "string" && typeof call.function.arguments === "string"))) throw new InferenceError("invalid_request", 400, "Invalid tool calls");
  }
  if (input.tools !== undefined && (!Array.isArray(input.tools) || input.tools.length > 128 || !input.tools.every((tool: unknown) => record(tool) && tool.type === "function" && Object.keys(tool).every((key) => ["type", "function"].includes(key)) && record(tool.function) && typeof tool.function.name === "string" && Object.keys(tool.function).every((key) => ["name", "description", "parameters", "strict"].includes(key))))) throw new InferenceError("invalid_request", 400, "Only function tools are supported");
  if (input.max_tokens !== undefined && input.max_completion_tokens !== undefined) throw new InferenceError("invalid_request", 400, "Specify one output token limit");
  const output = input.max_completion_tokens ?? input.max_tokens ?? model.maxOutputTokens;
  if (!positiveInteger(output) || output > model.maxOutputTokens) throw new InferenceError("invalid_request", 400, "Output token limit exceeds the model allowance");
  if (input.stream !== undefined && typeof input.stream !== "boolean") throw new InferenceError("invalid_request", 400, "Invalid stream option");
  // UTF-8 byte count plus structural overhead is deliberately conservative for text/tool inputs.
  const bytes = new TextEncoder().encode(JSON.stringify({ messages: input.messages, tools: input.tools })).length;
  if (bytes + input.messages.length * 64 + output > model.contextLength) throw new InferenceError("context_length_exceeded", 400, "Input exceeds the model context allowance");
  const { max_tokens: _tokens, max_completion_tokens: _completion, stream_options: _options, ...body } = input;
  return { body: { ...body, stream: input.stream === true, model: model.upstream, max_tokens: output, provider: { only: [model.provider], allow_fallbacks: false, require_parameters: true, max_price: { prompt: model.promptMicrosPerToken, completion: model.completionMicrosPerToken, request: model.requestMicros / 1_000_000 } } }, output };
}
