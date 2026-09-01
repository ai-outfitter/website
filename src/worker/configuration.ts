import type { Octokit } from "@octokit/core";
import { sourceFreshness, textBlob, type Repository } from "./github";
import { repositorySnapshot, workflowStatuses, type Catalog } from "./management";
import { summarizeSettings, type SettingsSource } from "./settings";

export type ConfigurationSource = SettingsSource & {
  dependencies: string[];
  repositoryUrl?: string;
};

export async function repositoryConfiguration(client: Octokit, login: string, repository: Repository | null, catalog: Catalog) {
  const repositoryUrl = `https://github.com/${encodeURIComponent(login)}/.agents`;
  if (!repository) return {
    login,
    repository: null,
    repositoryUrl,
    settings: { exists: false, valid: true, raw: "", defaults: {}, sources: [] as ConfigurationSource[] },
    workflows: catalog.workflows.map(({ files: _files, ...workflow }) => ({ ...workflow, state: "add" as const })),
  };
  const snapshot = await repositorySnapshot(client, login);
  const settingsEntry = snapshot.files["settings.yml"];
  const raw = settingsEntry ? await textBlob(client, login, settingsEntry.blobSha) : "";
  const summary = summarizeSettings(raw);
  const sources = summary.sources.map((source): ConfigurationSource => ({
    ...source,
    dependencies: Object.entries(snapshot.manifest?.workflows ?? {})
      .filter(([, workflow]) => source.github !== undefined && workflow.source.github === source.github)
      .map(([id]) => id)
      .sort(),
    ...(source.github ? { repositoryUrl: `https://github.com/${source.github}` } : {}),
  }));
  const statuses = workflowStatuses(catalog, snapshot);
  return {
    login,
    repository,
    repositoryUrl,
    settings: { exists: Boolean(settingsEntry), raw, ...summary, sources },
    workflows: catalog.workflows.map(({ files: _files, ...workflow }) => ({ ...workflow, ...statuses.find((status) => status.id === workflow.id) })),
  };
}

export async function configurationFreshness(client: Octokit, sources: ConfigurationSource[]) {
  return Promise.all(sources.map(async (source) => {
    if (source.kind === "path") return { id: source.id, status: "local-only" as const };
    if (source.kind === "invalid") return { id: source.id, status: "invalid" as const, reason: "A source must define exactly one location." };
    if (source.kind === "uri") return { id: source.id, status: "unavailable" as const, reason: "Automatic freshness checks currently support GitHub sources." };
    return { id: source.id, ...await sourceFreshness(client, source.github!, source.ref) };
  }));
}
