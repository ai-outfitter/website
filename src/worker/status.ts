import type { BundleFile, Catalog, ManagedManifest, RepositorySnapshot, WorkflowBundle, WorkflowStatus } from "./management";

function sameFile(file: BundleFile, snapshot: RepositorySnapshot) {
  const entry = snapshot.files[file.path];
  return Boolean(entry && (entry.sha256 === file.sha256 || entry.blobSha === file.blobSha) && entry.mode === file.mode);
}

export function classifyWorkflow(bundle: WorkflowBundle, catalog: Catalog, snapshot: RepositorySnapshot): WorkflowStatus {
  const declaration = bundle.files.find((file) => file.path === `workflows/${bundle.id}/workflow.yaml`);
  const managed = snapshot.manifest?.workflows[bundle.id];
  if (managed?.strategy === "catalog-reference") {
    const recordedChanged = Object.entries(managed.files).some(([path, hash]) => snapshot.files[path]?.sha256 !== hash);
    if (recordedChanged) return { id: bundle.id, state: "overridden", sourceSha: bundle.sourceSha, strategy: managed.strategy, reason: "The managed catalog reference was changed or removed." };
    return managed.sourceSha !== bundle.sourceSha || managed.source.github !== catalog.sourceRepository
      ? { id: bundle.id, state: "outdated", sourceSha: bundle.sourceSha, strategy: managed.strategy }
      : { id: bundle.id, state: "installed", sourceSha: bundle.sourceSha, strategy: managed.strategy };
  }
  if (managed && (!declaration || !snapshot.files[declaration.path])) return { id: bundle.id, state: "overridden", sourceSha: bundle.sourceSha, strategy: managed.strategy, reason: "A managed workflow declaration was removed from the repository." };
  if (!declaration || !snapshot.files[declaration.path]) return { id: bundle.id, state: "add", sourceSha: bundle.sourceSha };
  if (!managed) {
    const exact = bundle.files.every((file) => sameFile(file, snapshot));
    return exact
      ? { id: bundle.id, state: "installed", sourceSha: bundle.sourceSha }
      : { id: bundle.id, state: "overridden", sourceSha: bundle.sourceSha, reason: "The repository workflow differs from the current catalog version." };
  }
  const recordedChanged = Object.entries(managed.files).some(([path, hash]) => snapshot.files[path]?.sha256 !== hash);
  if (recordedChanged) return { id: bundle.id, state: "overridden", sourceSha: bundle.sourceSha, strategy: managed.strategy, reason: "A managed file was changed or removed in the repository." };
  if (managed.sourceSha !== bundle.sourceSha || managed.source.github !== catalog.sourceRepository) return { id: bundle.id, state: "outdated", sourceSha: bundle.sourceSha, strategy: managed.strategy };
  if (!bundle.files.filter((file) => file.path !== ".outfitter/workflow-composition.json").every((file) => sameFile(file, snapshot))) return { id: bundle.id, state: "overridden", sourceSha: bundle.sourceSha, strategy: managed.strategy, reason: "The installed workflow is incomplete or has been replaced." };
  return { id: bundle.id, state: "installed", sourceSha: bundle.sourceSha, strategy: managed?.strategy };
}

export function readManifest(value: unknown): ManagedManifest | null {
  if (!value || typeof value !== "object") return null;
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== 1 || !manifest.workflows || typeof manifest.workflows !== "object" || Array.isArray(manifest.workflows) || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) return null;
  for (const workflow of Object.values(manifest.workflows)) {
    if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) return null;
    const record = workflow as Record<string, unknown>;
    const source = record.source;
    if (!source || typeof source !== "object" || Array.isArray(source)) return null;
    const provenance = source as Record<string, unknown>;
    if (typeof provenance.github !== "string" || typeof provenance.ref !== "string" || typeof record.sourceSha !== "string" || (record.strategy !== "catalog-reference" && record.strategy !== "vendored") || typeof record.managesSource !== "boolean" || !record.files || typeof record.files !== "object" || Array.isArray(record.files) || Object.values(record.files).some((hash) => typeof hash !== "string")) return null;
  }
  for (const file of Object.values(manifest.files)) {
    if (!file || typeof file !== "object" || Array.isArray(file)) return null;
    const record = file as Record<string, unknown>;
    if (typeof record.sha256 !== "string" || !Array.isArray(record.workflows) || record.workflows.some((workflow) => typeof workflow !== "string")) return null;
  }
  return manifest as ManagedManifest;
}
