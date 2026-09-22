import { record } from "./models";

export interface GenerationObservation { id?: string; cost?: number }
export function observation(value: unknown): GenerationObservation {
  if (!record(value)) return {};
  const id = typeof value.id === "string" && /^[\w-]{1,200}$/.test(value.id) ? value.id : undefined;
  const cost = record(value.usage) && typeof value.usage.cost === "number" && Number.isFinite(value.usage.cost) && value.usage.cost >= 0 ? value.usage.cost : undefined;
  return { id, cost };
}
/** Incremental SSE parser: UTF-8, CRLF, and event boundaries may span network chunks. */
export class UsageParser {
  private decoder = new TextDecoder();
  private pending = "";
  private event: string[] = [];
  private ended = false;
  private eventBytes = 0;
  constructor(private observe: (value: GenerationObservation) => Promise<void>) {}
  async push(chunk: Uint8Array, final = false) {
    if (this.ended) return;
    this.pending += this.decoder.decode(chunk, { stream: !final });
    if (this.pending.length > 1_048_576) throw new Error("Upstream event too large");
    let newline: number;
    while ((newline = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, newline).replace(/\r$/, "");
      this.pending = this.pending.slice(newline + 1);
      if (!line) await this.flush();
      else if (line.startsWith("data:")) {
        this.eventBytes += line.length;
        if (this.eventBytes > 1_048_576) throw new Error("Upstream event too large");
        this.event.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (final) {
      if (this.pending.startsWith("data:")) this.event.push(this.pending.slice(5).trimStart());
      this.pending = "";
      await this.flush();
    }
  }
  private async flush() {
    const text = this.event.join("\n");
    this.event = [];
    this.eventBytes = 0;
    if (!text) return;
    if (text === "[DONE]") { this.ended = true; return; }
    await this.observe(observation(JSON.parse(text)));
  }
}
export async function boundedText(response: Pick<Response, "body">, maximum: number) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maximum) { await reader.cancel(); throw new Error("Body too large"); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}
