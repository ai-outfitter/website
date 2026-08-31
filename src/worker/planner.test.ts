import { describe, expect, it } from "vitest";
import { buildPlan, isManagedPath, managedBundleFiles, repositorySnapshot, sha256, signPlan, verifyPlan, type Catalog, type Plan, type WorkflowBundle } from "./planner";

const plan = (expiresAt = Date.now() + 60_000): Plan => ({
  version: 1,
  repository: "octo/.agents",
  baseSha: "base",
  sourceSha: "source",
  changes: [{ path: "agents/engineer/agent.md", action: "add", before: null, after: "# Engineer", mode: "100644" }],
  warnings: [],
  expiresAt,
});

describe("signed repository plans", () => {
  it("adds a source-pinned ownership manifest to exact workflow files", async () => {
    const files = await managedBundleFiles({ id: "review", sourceSha: "a".repeat(40), files: [{ path: "workflows/review/workflow.yaml", content: "id: review\n", mode: "100644", sha256: "unused" }] });
    expect(files.map((file) => file.path)).toEqual(["workflows/review/workflow.yaml", ".outfitter/website-managed.json"]);
    expect(files[1].content).toContain('"version": 2');
    expect(files[1].content).toContain('"review": {');
    expect(files[1].content).toContain('"sourceSha": "aaaaaaaa');
  });

  it("creates a deterministic union with shared ownership and no composition singleton", async () => {
    const shared = { path: "skills/shared/SKILL.md", content: "shared", mode: "100644" as const, sha256: "hash" };
    const bundles: WorkflowBundle[] = [
      { id: "one", sourceSha: "source", files: [shared, { path: ".outfitter/workflow-composition.json", content: "one", mode: "100644", sha256: "one" }] },
      { id: "two", sourceSha: "source", files: [shared, { path: "workflows/two/workflow.yaml", content: "two", mode: "100644", sha256: "two" }] },
    ];
    const files = await managedBundleFiles(bundles);
    expect(files.filter((file) => file.path === "skills/shared/SKILL.md")).toHaveLength(1);
    expect(files.some((file) => file.path === ".outfitter/workflow-composition.json")).toBe(false);
    expect(files.at(-1)?.content).toContain('"workflows": [\n        "one",\n        "two"');
  });

  it("rejects shared-path content collisions", async () => {
    const file = (content: string) => ({ path: "skills/shared/SKILL.md", content, mode: "100644" as const, sha256: content });
    await expect(managedBundleFiles([{ id: "one", sourceSha: "source", files: [file("one")] }, { id: "two", sourceSha: "source", files: [file("two")] }])).rejects.toThrow("Catalog collision");
  });
  it("round trips the exact preview", async () => {
    const token = await signPlan(plan(), "test-plan-secret");
    expect(await verifyPlan(token, "test-plan-secret")).toMatchObject({ repository: "octo/.agents", baseSha: "base" });
  });

  it("rejects tampering", async () => {
    const token = await signPlan(plan(), "test-plan-secret");
    await expect(verifyPlan(`${token.slice(0, -1)}x`, "test-plan-secret")).rejects.toThrow("Invalid plan token");
  });

  it("rejects expired previews", async () => {
    const token = await signPlan(plan(Date.now() - 1), "test-plan-secret");
    await expect(verifyPlan(token, "test-plan-secret")).rejects.toThrow("Plan expired");
  });

  it("rejects nested .agents directories in workload repositories", async () => {
    const workflow: WorkflowBundle = { id: "review", sourceSha: "a".repeat(40), files: [{ path: "workflows/review/workflow.yaml", content: "id: review\n", mode: "100644", sha256: "unused" }] };
    const request = async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}") return { data: { sha: "head" } };
      if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") return { data: { sha: "tree-object", truncated: false, tree: [] } };
      throw new Error(`Unexpected request: ${route}`);
    };
    await expect(buildPlan({ request } as never, { repository: "octo/project", catalog: { sourceSha: workflow.sourceSha, workflows: [workflow] }, workflow: "review" })).rejects.toThrow("Invalid workflow or .agents repository selection");
  });

  it("keeps manifest records inside the managed path boundary", () => {
    expect(isManagedPath("skills/reviewer/SKILL.md")).toBe(true);
    expect(isManagedPath("README.md")).toBe(false);
    expect(isManagedPath("skills/../README.md")).toBe(false);
    expect(isManagedPath(".outfitter/website-managed.json")).toBe(false);
  });

  it("removes the complete owning workflow when a managed resource is selected", async () => {
    const declaration = "id: review\n";
    const skill = "review instructions\n";
    const sourceSha = "b".repeat(40);
    const workflow: WorkflowBundle = { id: "review", sourceSha, files: [
      { path: "workflows/review/workflow.yaml", content: declaration, mode: "100644", sha256: await sha256(declaration) },
      { path: "skills/reviewer/SKILL.md", content: skill, mode: "100644", sha256: await sha256(skill) },
    ] };
    const managed = await managedBundleFiles(workflow);
    const blobs = Object.fromEntries(managed.map((file, index) => [`blob-${index}`, file.content]));
    const tree = managed.map((file, index) => ({ path: file.path, mode: file.mode, type: "blob", sha: `blob-${index}` }));
    const request = async (route: string, input: Record<string, unknown>) => {
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}") return { data: { sha: "head" } };
      if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") return { data: { sha: "head", truncated: false, tree } };
      if (route === "GET /repos/{owner}/{repo}/git/blobs/{file_sha}") return { data: { encoding: "base64", content: btoa(blobs[String(input.file_sha)]) } };
      throw new Error(`Unexpected request: ${route}`);
    };
    const catalog: Catalog = { sourceSha, workflows: [workflow] };
    const snapshot = await repositorySnapshot({ request } as never, "octo");
    expect(snapshot.manifest?.workflows).toHaveProperty("review");
    expect(snapshot.files["skills/reviewer/SKILL.md"].sha256).toBe(await sha256(skill));
    const result = await buildPlan({ request } as never, { repository: "octo/.agents", catalog, deletes: ["skills/reviewer"] });
    expect(result.changes.map((change) => [change.action, change.path])).toEqual([
      ["delete", "skills/reviewer/SKILL.md"],
      ["delete", "workflows/review/workflow.yaml"],
      ["delete", ".outfitter/website-managed.json"],
    ]);
  });
});
