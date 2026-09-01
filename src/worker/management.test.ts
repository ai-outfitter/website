import { describe, expect, it } from "vitest";
import { isManagedPath, managedBundleFiles, sha256, signPlan, verifyPlan, type Plan, type WorkflowBundle } from "./management";

const workflow = (sourceSha = "a".repeat(40)): WorkflowBundle => ({
  id: "review",
  sourceRepository: "ai-outfitter/community-profiles",
  sourceSha,
  files: [{ path: "workflows/review/workflow.yaml", content: "id: review\n", mode: "100644", sha256: "unused" }],
});
const plan = (expiresAt = Date.now() + 60_000): Plan => ({
  version: 1,
  repository: "octo/.agents",
  baseSha: "base",
  sourceSha: "source",
  intent: { target: "workflow", id: "review", action: "install" },
  changes: [{ path: "agents/engineer/agent.md", action: "add", before: null, after: "# Engineer", mode: "100644" }],
  warnings: [],
  expiresAt,
});

describe("managed workflow plans", () => {
  it("writes the one supported ownership manifest for vendored files", async () => {
    const files = await managedBundleFiles(workflow());
    expect(files.map((file) => file.path)).toEqual(["workflows/review/workflow.yaml", ".outfitter/website-managed.json"]);
    expect(JSON.parse(files.at(-1)!.content)).toMatchObject({
      version: 1,
      workflows: { review: { strategy: "vendored", managesSource: false, source: { github: "ai-outfitter/community-profiles", ref: "a".repeat(40) } } },
    });
  });

  it("preserves settings comments and unrelated sources when pinning a catalog", async () => {
    const files = await managedBundleFiles(workflow("b".repeat(40)), "catalog-reference", "# keep this\ndefault_agent: engineer\nsources:\n  - github: example/private\n    ref: main\n  - github: ai-outfitter/community-profiles\n    ref: v1\n");
    expect(files[0].content).toContain("# keep this");
    expect(files[0].content).toContain("github: example/private");
    expect(files[0].content).toContain("github: ai-outfitter/community-profiles");
    expect(files[0].content).toContain(`ref: ${"b".repeat(40)}`);
    expect(JSON.parse(files.at(-1)!.content).workflows.review.managesSource).toBe(false);
  });

  it("creates a deterministic union with shared ownership", async () => {
    const shared = { path: "skills/shared/SKILL.md", content: "shared", mode: "100644" as const, sha256: await sha256("shared") };
    const bundles: WorkflowBundle[] = [{ ...workflow(), id: "one", files: [shared] }, { ...workflow(), id: "two", files: [shared] }];
    const files = await managedBundleFiles(bundles);
    expect(files.filter((file) => file.path === shared.path)).toHaveLength(1);
    expect(files.at(-1)?.content).toContain('"workflows": [\n        "one",\n        "two"');
  });

  it("round trips exact signed previews and rejects tampering or expiry", async () => {
    const token = await signPlan(plan(), "test-plan-secret");
    expect(await verifyPlan(token, "test-plan-secret")).toMatchObject({ repository: "octo/.agents", baseSha: "base" });
    await expect(verifyPlan(`${token.slice(0, -1)}x`, "test-plan-secret")).rejects.toThrow("Invalid plan token");
    await expect(verifyPlan(await signPlan(plan(Date.now() - 1), "test-plan-secret"), "test-plan-secret")).rejects.toThrow("Plan expired");
  });

  it("keeps manifest records inside the managed path boundary", () => {
    expect(isManagedPath("skills/reviewer/SKILL.md")).toBe(true);
    expect(isManagedPath("README.md")).toBe(false);
    expect(isManagedPath("skills/../README.md")).toBe(false);
    expect(isManagedPath(".outfitter/website-managed.json")).toBe(false);
  });
});
