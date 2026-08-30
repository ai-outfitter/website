import { describe, expect, it } from "vitest";
import { signPlan, verifyPlan, type Plan } from "./planner";

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
