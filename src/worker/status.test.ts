import { describe, expect, it } from "vitest";
import { classifyWorkflow, normalizeManifest } from "./status";
import type { Catalog, RepositorySnapshot, WorkflowBundle } from "./planner";

const workflow: WorkflowBundle = { id: "review", sourceSha: "new", files: [
  { path: "workflows/review/workflow.yaml", content: "id: review", mode: "100644", sha256: "declaration", blobSha: "blob-declaration" },
  { path: "skills/reviewer/SKILL.md", content: "review", mode: "100644", sha256: "skill", blobSha: "blob-skill" },
] };
const catalog: Catalog = { sourceSha: "new", workflows: [workflow] };
const snapshot = (files: RepositorySnapshot["files"], manifest: RepositorySnapshot["manifest"] = null): RepositorySnapshot => ({ sha: "head", files, manifest });

describe("workflow repository status", () => {
  it("classifies absent, exact unmanaged, and incomplete unmanaged workflows", () => {
    expect(classifyWorkflow(workflow, catalog, snapshot({})).state).toBe("add");
    expect(classifyWorkflow(workflow, catalog, snapshot({
      "workflows/review/workflow.yaml": { mode: "100644", blobSha: "blob-declaration" },
      "skills/reviewer/SKILL.md": { mode: "100644", blobSha: "blob-skill" },
    })).state).toBe("installed");
    expect(classifyWorkflow(workflow, catalog, snapshot({ "workflows/review/workflow.yaml": { mode: "100644", blobSha: "blob-declaration" } })).state).toBe("overridden");
  });

  it("distinguishes unchanged old installs from modified managed files", () => {
    const manifest = normalizeManifest({ version: 1, workflow: "review", sourceSha: "old", files: { "workflows/review/workflow.yaml": "declaration", "skills/reviewer/SKILL.md": "skill" } });
    const exact = { "workflows/review/workflow.yaml": { mode: "100644", blobSha: "x", sha256: "declaration" }, "skills/reviewer/SKILL.md": { mode: "100644", blobSha: "y", sha256: "skill" } };
    expect(classifyWorkflow(workflow, catalog, snapshot(exact, manifest)).state).toBe("outdated");
    expect(classifyWorkflow(workflow, catalog, snapshot({ ...exact, "skills/reviewer/SKILL.md": { mode: "100644", blobSha: "changed", sha256: "changed" } }, manifest)).state).toBe("overridden");
    expect(classifyWorkflow(workflow, catalog, snapshot({}, manifest)).state).toBe("overridden");
  });

  it("reads v1 manifests as v2 provenance", () => {
    expect(normalizeManifest({ version: 1, workflow: "review", sourceSha: "old", files: { "a": "hash" } })).toEqual({ version: 2, catalogSha: "old", workflows: { review: { sourceSha: "old", files: { a: "hash" } } }, files: { a: { sha256: "hash", workflows: ["review"] } } });
  });
});
