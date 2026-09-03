import type { Octokit } from "@octokit/core";
import { sourceFreshness, textBlob, type Repository } from "./github";
import { repositorySnapshot, type Catalog } from "./management";
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
    settings: { exists: false, valid: true, raw: "", defaults: {}, sources: [] as ConfigurationSource[], workflows: [] },
    workflows: catalog.workflows.map(({ files: _files, ...workflow }) => ({ ...workflow, state: "available" as const, components: [] })),
  };
  const snapshot = await repositorySnapshot(client, login);
  const settingsEntry = snapshot.files["settings.yml"];
  const raw = settingsEntry ? await textBlob(client, login, settingsEntry.blobSha) : "";
  const summary = summarizeSettings(raw);
  const sources = summary.sources.map((source): ConfigurationSource => ({
    ...source,
    dependencies: source.github === catalog.sourceRepository ? summary.workflows : [],
    ...(source.github ? { repositoryUrl: `https://github.com/${source.github}` } : {}),
  }));
  const catalogSource = summary.sources.find((source) => source.github === catalog.sourceRepository);
  return {
    login,
    repository: { ...repository, headSha: snapshot.sha },
    repositoryUrl,
    settings: { exists: Boolean(settingsEntry), raw, ...summary, sources },
    workflows: catalog.workflows.map(({ files, ...workflow }) => {
      const enabled = summary.workflows.includes(workflow.id);
      const customized = enabled && files.some((file) => file.path.startsWith("agents/") && snapshot.files[file.path]);
      const state = !enabled ? "available" : !catalogSource ? "needs-attention" : customized ? "customized" : "enabled";
      const components = files
        .filter((file) => !file.path.startsWith(".outfitter/"))
        .map((file) => ({ type: file.path.split("/")[0], component: file.path, origin: snapshot.files[file.path] ? "organization" : catalog.sourceRepository }));
      return { ...workflow, state, ...(state === "needs-attention" ? { reason: "The enabled workflow's catalog source is missing." } : {}), components };
    }),
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
