import { isMap, isSeq, parseDocument, type Document, type YAMLMap } from "yaml";

export type SettingsSource = {
  id: string;
  section: "sources" | "remote_settings";
  index: number;
  kind: "github" | "uri" | "path" | "invalid";
  location: string;
  github?: string;
  uri?: string;
  path?: string;
  ref?: string;
};

export type SettingsSummary = {
  valid: boolean;
  error?: string;
  defaults: { agent?: string };
  sources: SettingsSource[];
  workflows: string[];
};

function document(source: string): Document {
  return parseDocument(source || "{}", { keepSourceTokens: true });
}

function string(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sourceAt(section: SettingsSource["section"], index: number, value: unknown): SettingsSource {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const github = string(record.github);
  const uri = string(record.uri);
  const path = string(record.path);
  const ref = string(record.ref);
  const locations = [github, uri, section === "sources" ? path : undefined].filter(Boolean);
  const kind = locations.length !== 1 ? "invalid" : github ? "github" : uri ? "uri" : "path";
  return {
    id: `${section}:${index}`,
    section,
    index,
    kind,
    location: github ?? uri ?? path ?? "Invalid source",
    ...(github ? { github } : {}),
    ...(uri ? { uri } : {}),
    ...(path ? { path } : {}),
    ...(ref ? { ref } : {}),
  };
}

export function summarizeSettings(source: string): SettingsSummary {
  const parsed = document(source);
  if (parsed.errors.length) return { valid: false, error: parsed.errors[0].message, defaults: {}, sources: [], workflows: [] };
  const value = parsed.toJS() as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, error: "settings.yml must contain a mapping", defaults: {}, sources: [], workflows: [] };
  const settings = value as Record<string, unknown>;
  const sources: SettingsSource[] = [];
  for (const section of ["sources", "remote_settings"] as const) {
    const values = settings[section];
    if (values !== undefined && !Array.isArray(values)) return { valid: false, error: `${section} must be a sequence`, defaults: {}, sources: [], workflows: [] };
    for (const [index, entry] of (values ?? [] as unknown[]).entries()) sources.push(sourceAt(section, index, entry));
  }
  const workflows = settings.workflows;
  if (workflows !== undefined && (!Array.isArray(workflows) || workflows.some((id) => !string(id)))) return { valid: false, error: "workflows must be a sequence of IDs", defaults: {}, sources: [], workflows: [] };
  return {
    valid: true,
    defaults: { ...(string(settings.default_agent) ? { agent: string(settings.default_agent) } : {}) },
    sources,
    workflows: [...new Set((workflows ?? []) as string[])],
  };
}

export function setWorkflowEnablement(source: string | undefined, workflow: string, enabled: boolean) {
  const parsed = document(source ?? "{}\n");
  if (parsed.errors.length || !isMap(parsed.contents)) throw new Error("settings.yml is invalid");
  let sequence = parsed.get("workflows", true);
  if (sequence === undefined) { parsed.set("workflows", parsed.createNode([])); sequence = parsed.get("workflows", true); }
  if (!isSeq(sequence)) throw new Error("workflows must be a sequence");
  const index = sequence.items.findIndex((item) => String(item) === workflow);
  if (enabled && index < 0) sequence.add(workflow);
  if (!enabled && index >= 0) sequence.items.splice(index, 1);
  return String(parsed);
}

function sourceMap(parsed: Document, id: string) {
  const match = id.match(/^(sources|remote_settings):(\d+)$/);
  if (!match) throw new Error("Invalid source selection");
  const section = match[1] as SettingsSource["section"];
  const index = Number(match[2]);
  const sequence = parsed.get(section, true);
  if (!isSeq(sequence) || !isMap(sequence.items[index])) throw new Error("The selected source no longer exists");
  return { section, index, sequence, map: sequence.items[index] as YAMLMap };
}

export function setSourceRef(source: string, id: string, ref: string) {
  const parsed = document(source);
  if (parsed.errors.length) throw new Error("settings.yml is invalid");
  const selected = sourceMap(parsed, id);
  selected.map.set("ref", ref);
  return String(parsed);
}

export function removeSource(source: string, id: string) {
  const parsed = document(source);
  if (parsed.errors.length) throw new Error("settings.yml is invalid");
  const selected = sourceMap(parsed, id);
  selected.sequence.items.splice(selected.index, 1);
  return String(parsed);
}

export function pinGitHubSource(source: string | undefined, github: string, ref: string) {
  const parsed = document(source ?? "{}\n");
  if (parsed.errors.length) throw new Error("settings.yml is invalid");
  const root = parsed.contents;
  if (!isMap(root)) throw new Error("settings.yml must contain a mapping");
  let sequence = parsed.get("sources", true);
  if (sequence === undefined) {
    parsed.set("sources", parsed.createNode([]));
    sequence = parsed.get("sources", true);
  }
  if (!isSeq(sequence)) throw new Error("sources must be a sequence");
  const existing = sequence.items.find((item) => isMap(item) && item.get("github") === github);
  if (isMap(existing)) existing.set("ref", ref);
  else sequence.add({ github, ref });
  return String(parsed);
}

export function unpinGitHubSource(source: string, github: string) {
  const parsed = document(source);
  if (parsed.errors.length) throw new Error("settings.yml is invalid");
  const sequence = parsed.get("sources", true);
  if (!isSeq(sequence)) return String(parsed);
  const index = sequence.items.findIndex((item) => isMap(item) && item.get("github") === github);
  if (index >= 0) sequence.items.splice(index, 1);
  return String(parsed);
}
