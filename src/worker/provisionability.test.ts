import { describe, expect, it, vi } from "vitest";
import { ProvisionabilityError, verifyProvisioningWorkflow } from "./provisionability";

function encoded(source: string) {
  return btoa(source);
}

function client(source = "on:\n  workflow_dispatch:\njobs: {}\n", state = "active") {
  return {
    request: vi.fn(async (route: string, parameters: Record<string, unknown>) => {
      if (route.includes("actions/workflows")) {
        return { data: { state, path: ".github/workflows/deploy.yml" } };
      }
      return { data: { type: "file", encoding: "base64", content: encoded(source), size: source.length, parameters } };
    }),
  };
}

describe("verifyProvisioningWorkflow", () => {
  it("verifies the active workflow and dispatch trigger on the deployed ref", async () => {
    const github = client();
    await verifyProvisioningWorkflow(github as never, "Unsupervisedcom", "deploy.yml");
    expect(github.request).toHaveBeenNthCalledWith(1,
      "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}",
      { owner: "Unsupervisedcom", repo: ".agents", workflow_id: "deploy.yml" });
    expect(github.request).toHaveBeenNthCalledWith(2,
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner: "Unsupervisedcom", repo: ".agents", path: ".github/workflows/deploy.yml", ref: "main" });
  });

  it("rejects inactive workflows", async () => {
    await expect(verifyProvisioningWorkflow(client("on: workflow_dispatch", "disabled_manually") as never,
      "Unsupervisedcom", "deploy.yml")).rejects.toEqual(new ProvisionabilityError("inactive"));
  });

  it("rejects workflows without workflow_dispatch", async () => {
    await expect(verifyProvisioningWorkflow(client("on: push\njobs: {}\n") as never,
      "Unsupervisedcom", "deploy.yml")).rejects.toEqual(new ProvisionabilityError("invalid"));
  });

  it("rejects malformed workflow YAML", async () => {
    await expect(verifyProvisioningWorkflow(client("on: [workflow_dispatch\n") as never,
      "Unsupervisedcom", "deploy.yml")).rejects.toEqual(new ProvisionabilityError("invalid"));
  });

  it("accepts list-form workflow triggers", async () => {
    await expect(verifyProvisioningWorkflow(client("on: [push, workflow_dispatch]\njobs: {}\n") as never,
      "Unsupervisedcom", "deploy.yml")).resolves.toBeUndefined();
  });
});
