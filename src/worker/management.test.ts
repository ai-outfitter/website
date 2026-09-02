import { describe, expect, it } from "vitest";
import { buildPlan, catalogFrom, signPlan, verifyPlan, type Plan, type WorkflowBundle } from "./management";
import { summarizeSettings } from "./settings";
const plan = (expiresAt = Date.now() + 60_000): Plan => ({
  version: 1,
  repository: "octo/.agents",
  baseSha: "base",
  sourceSha: "source",
  intent: { target: "workflow", id: "review", action: "accept" },
  changes: [{ path: "settings.yml", action: "add", before: null, after: "workflows:\n  - review\n", mode: "100644" }],
  warnings: [],
  expiresAt,
});

describe("workflow acceptance plans", () => {
  it("creates only settings.yml and pins the catalog release tag", async () => {
    const workflow: WorkflowBundle = { id: "review", sourceRepository: "ai-outfitter/community-profiles", sourceRef: "v-test", sourceSha: "a".repeat(40), files: [] };
    const result = await buildPlan({} as never, { repository: "acme/.agents", catalog: catalogFrom([workflow]), request: { target: "workflow", workflow: "review", action: "accept" }, repositoryExists: false });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ path: "settings.yml", action: "add" });
    expect(summarizeSettings(result.changes[0].after!).workflows).toEqual(["review"]);
    expect(result.changes[0].after).toContain("ref: v-test");
    expect(result.changes.some((change) => change.path.startsWith(".outfitter/") || change.path.startsWith("workflows/"))).toBe(false);
  });

  it("round trips exact signed previews and rejects tampering or expiry", async () => {
    const token = await signPlan(plan(), "test-plan-secret");
    expect(await verifyPlan(token, "test-plan-secret")).toMatchObject({ repository: "octo/.agents", baseSha: "base" });
    await expect(verifyPlan(`${token.slice(0, -1)}x`, "test-plan-secret")).rejects.toThrow("Invalid plan token");
    await expect(verifyPlan(await signPlan(plan(Date.now() - 1), "test-plan-secret"), "test-plan-secret")).rejects.toThrow("Plan expired");
  });
});
