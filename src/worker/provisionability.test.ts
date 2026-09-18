import { describe, expect, it, vi } from "vitest";
import { pilotAccountAllowed, ProvisionabilityError, verifyProvisioningWorkflow } from "./provisionability";

function encoded(source: string) {
  return btoa(source);
}

const validWorkflow = `
on:
  workflow_dispatch:
permissions:
  contents: read
  id-token: write
jobs:
  provision:
    uses: Unsupervisedcom/.agents/.github/workflows/deploy.yml@main
`;

function client(source = validWorkflow, state = "active", path = ".github/workflows/provision-resident.yml") {
  return {
    request: vi.fn(async (route: string, parameters: Record<string, unknown>) => {
      if (route.includes("actions/workflows")) {
        return { data: { state, path } };
      }
      return { data: { type: "file", encoding: "base64", content: encoded(source), size: source.length, parameters } };
    }),
  };
}

describe("verifyProvisioningWorkflow", () => {
  it("limits checkout to explicitly configured immutable GitHub account IDs", () => {
    expect(pilotAccountAllowed(36771436, "36771436, 123")).toBe(true);
    expect(pilotAccountAllowed(999, "36771436,123")).toBe(false);
    expect(pilotAccountAllowed(36771436, undefined)).toBe(false);
    expect(pilotAccountAllowed(36771436, "36771436,not-an-id")).toBe(false);
  });

  it("verifies the active workflow and dispatch trigger on the deployed ref", async () => {
    const github = client();
    await verifyProvisioningWorkflow(github as never, "Unsupervisedcom", "provision-resident.yml");
    expect(github.request).toHaveBeenNthCalledWith(1,
      "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}",
      { owner: "Unsupervisedcom", repo: ".agents", workflow_id: "provision-resident.yml" });
    expect(github.request).toHaveBeenNthCalledWith(2,
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner: "Unsupervisedcom", repo: ".agents", path: ".github/workflows/provision-resident.yml", ref: "main" });
  });

  it("rejects inactive workflows", async () => {
    await expect(verifyProvisioningWorkflow(client(validWorkflow, "disabled_manually") as never,
      "Unsupervisedcom", "provision-resident.yml")).rejects.toEqual(new ProvisionabilityError("inactive"));
  });

  it("rejects a metadata path other than the configured workflow", async () => {
    await expect(verifyProvisioningWorkflow(client(validWorkflow, "active", ".github/workflows/deploy.yml") as never,
      "Unsupervisedcom", "provision-resident.yml")).rejects.toEqual(new ProvisionabilityError("invalid"));
  });

  it.each([
    ["no dispatch trigger", validWorkflow.replace("workflow_dispatch:", "push:")],
    ["a list-form dispatch trigger", validWorkflow.replace("on:\n  workflow_dispatch:", "on: [workflow_dispatch]")],
    ["an additional automatic trigger", validWorkflow.replace("  workflow_dispatch:", "  workflow_dispatch:\n  push:")],
    ["malformed YAML", "on: [workflow_dispatch\n"],
    ["no jobs", validWorkflow.replace(/jobs:[\s\S]*/, "jobs: {}\n")],
    ["more than one job", `${validWorkflow}  unexpected:\n    uses: Unsupervisedcom/.agents/.github/workflows/deploy.yml@main\n`],
    ["an unpinned local reusable workflow", validWorkflow.replace("Unsupervisedcom/.agents/.github/workflows/deploy.yml@main", "./.github/workflows/deploy.yml")],
    ["a reusable workflow on another ref", validWorkflow.replace("@main", "@feature/resident")],
    ["a different reusable workflow", validWorkflow.replace("deploy.yml", "other.yml")],
    ["arbitrary runner steps", validWorkflow.replace("    uses:", "    runs-on: ubuntu-latest\n    steps: []\n    uses:")],
    ["missing OIDC permission", validWorkflow.replace("  id-token: write\n", "")],
    ["broader permissions", validWorkflow.replace("  contents: read", "  contents: write")],
    ["an additional permission", validWorkflow.replace("  id-token: write", "  id-token: write\n  actions: write")],
  ])("rejects %s", async (_case, source) => {
    await expect(verifyProvisioningWorkflow(client(source) as never,
      "Unsupervisedcom", "provision-resident.yml")).rejects.toEqual(new ProvisionabilityError("invalid"));
  });

  it("accepts exact least-privilege permissions on the reusable-workflow job", async () => {
    const source = validWorkflow
      .replace("permissions:\n  contents: read\n  id-token: write\n", "")
      .replace("    uses:", "    permissions:\n      contents: read\n      id-token: write\n    uses:");
    await expect(verifyProvisioningWorkflow(client(source) as never,
      "Unsupervisedcom", "provision-resident.yml")).resolves.toBeUndefined();
  });

  it("fails closed when the workflow file is missing on main", async () => {
    const github = {
      request: vi.fn(async (route: string) => {
        if (route.includes("actions/workflows")) {
          return { data: { state: "active", path: ".github/workflows/provision-resident.yml" } };
        }
        throw Object.assign(new Error("Not Found"), { status: 404 });
      }),
    };
    await expect(verifyProvisioningWorkflow(github as never,
      "Unsupervisedcom", "provision-resident.yml")).rejects.toMatchObject({ status: 404 });
  });
});
