import { describe, expect, it } from "vitest";
import { managedBundleFiles, signPlan, verifyPlan, type Plan, type WorkflowBundle } from "./planner";

const plan = (expiresAt = Date.now() + 60_000): Plan => ({
  version: 1,
  repository: "octo/repo",
  baseSha: "base",
  sourceSha: "source",
  managedRoot: ".agents",
  changes: [{ path: ".agents/agents/engineer/agent.md", action: "add", before: null, after: "# Engineer", mode: "100644" }],
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
    expect(await verifyPlan(token, "test-plan-secret")).toMatchObject({ repository: "octo/repo", baseSha: "base" });
  });

  it("rejects tampering", async () => {
    const token = await signPlan(plan(), "test-plan-secret");
    await expect(verifyPlan(`${token.slice(0, -1)}x`, "test-plan-secret")).rejects.toThrow("Invalid plan token");
  });

  it("rejects expired previews", async () => {
    const token = await signPlan(plan(Date.now() - 1), "test-plan-secret");
    await expect(verifyPlan(token, "test-plan-secret")).rejects.toThrow("Plan expired");
  });
});
