import type { BundleFile, Catalog, ManagedManifest, RepositorySnapshot, WorkflowBundle, WorkflowStatus } from "./planner";

function sameFile(file: BundleFile, snapshot: RepositorySnapshot) {
  const entry = snapshot.files[file.path];
  return Boolean(entry && (entry.sha256 === file.sha256 || entry.blobSha === file.blobSha) && entry.mode === file.mode);
}

export function classifyWorkflow(bundle: WorkflowBundle, catalog: Catalog, snapshot: RepositorySnapshot): WorkflowStatus {
  const declaration = bundle.files.find((file) => file.path === `workflows/${bundle.id}/workflow.yaml`);
  const managed = snapshot.manifest?.workflows[bundle.id];
  if (managed?.mode === "required") {
    const recordedChanged = Object.entries(managed.files).some(([path, hash]) => snapshot.files[path]?.sha256 !== hash);
    if (recordedChanged) return { id: bundle.id, state: "overridden", action: "none", sourceSha: bundle.sourceSha, reason: "The managed catalog reference was changed or removed." };
    return managed.sourceSha !== bundle.sourceSha || snapshot.manifest?.catalogSha !== catalog.sourceSha
      ? { id: bundle.id, state: "outdated", action: "update", sourceSha: bundle.sourceSha }
      : { id: bundle.id, state: "installed", action: "none", sourceSha: bundle.sourceSha };
  }
  if (managed && (!declaration || !snapshot.files[declaration.path])) return { id: bundle.id, state: "overridden", action: "none", sourceSha: bundle.sourceSha, reason: "A managed workflow declaration was removed from the repository." };
  if (!declaration || !snapshot.files[declaration.path]) return { id: bundle.id, state: "add", action: "add", sourceSha: bundle.sourceSha };
  if (!managed) {
    const exact = bundle.files.every((file) => sameFile(file, snapshot));
    return exact
      ? { id: bundle.id, state: "installed", action: "none", sourceSha: bundle.sourceSha }
      : { id: bundle.id, state: "overridden", action: "none", sourceSha: bundle.sourceSha, reason: "The repository workflow differs from the current catalog version." };
  }
  const recordedChanged = Object.entries(managed.files).some(([path, hash]) => snapshot.files[path]?.sha256 !== hash);
  if (recordedChanged) return { id: bundle.id, state: "overridden", action: "none", sourceSha: bundle.sourceSha, reason: "A managed file was changed or removed in the repository." };
  if (managed.sourceSha !== bundle.sourceSha || snapshot.manifest?.catalogSha !== catalog.sourceSha) return { id: bundle.id, state: "outdated", action: "update", sourceSha: bundle.sourceSha };
  if (!bundle.files.every((file) => sameFile(file, snapshot))) return { id: bundle.id, state: "overridden", action: "none", sourceSha: bundle.sourceSha, reason: "The installed workflow is incomplete or has been replaced." };
  return { id: bundle.id, state: "installed", action: "none", sourceSha: bundle.sourceSha };
}

export function normalizeManifest(value: unknown): ManagedManifest | null {
  if (!value || typeof value !== "object") return null;
  const manifest = value as Record<string, unknown>;
  if (manifest.version === 2 && manifest.workflows && manifest.files) return manifest as unknown as ManagedManifest;
  if (manifest.version === 1 && typeof manifest.workflow === "string" && typeof manifest.sourceSha === "string" && manifest.files && typeof manifest.files === "object") {
    const files = manifest.files as Record<string, string>;
    return {
      version: 2,
      catalogSha: manifest.sourceSha,
      workflows: { [manifest.workflow]: { sourceSha: manifest.sourceSha, files } },
      files: Object.fromEntries(Object.entries(files).map(([path, sha256]) => [path, { sha256, workflows: [manifest.workflow as string] }])),
    };
  }
  return null;
}
