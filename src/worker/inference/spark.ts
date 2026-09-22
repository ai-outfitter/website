import { configuration, type HostedModel } from "./models";

export interface SparkConfiguration {
  enabled: boolean;
  users: string;
  models: string;
  baseUrl?: string;
  apiKey?: string;
}
export function sparkModels(settings: SparkConfiguration | undefined, userId: string): HostedModel[] {
  if (!settings?.enabled || !settings.users.split(",").map((id) => id.trim()).filter((id) => /^github:[1-9]\d*$/.test(id)).includes(userId)) return [];
  const models = configuration(JSON.stringify({ models: JSON.parse(settings.models), rate: { version: "internal-spark-v1", markupBps: 0 } })).models;
  for (const model of models) {
    if (!model.id.startsWith("spark/") || [model.promptMicrosPerToken, model.completionMicrosPerToken, model.cacheReadMicrosPerToken, model.cacheWriteMicrosPerToken, model.requestMicros].some((price) => price !== 0)) throw new Error("Internal Spark models must use their namespace and zero customer pricing");
  }
  return models;
}
export function sparkEndpoint(settings: SparkConfiguration) {
  if (!settings.baseUrl || !settings.apiKey) throw new Error("Spark unavailable");
  const url = new URL(settings.baseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !/^\/.*v1\/?$/.test(url.pathname)) throw new Error("Invalid Spark gateway URL");
  return `${url.href.replace(/\/$/, "")}/chat/completions`;
}
