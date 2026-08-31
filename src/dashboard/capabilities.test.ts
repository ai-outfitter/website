import { describe, expect, it } from "vitest";
import {
  assessBringYourOwnKey,
  assessGitHubActionsSetup,
  assessHostedInference,
  assessLocalExecution,
  assessManagedOperations,
  assessResidentDeployment,
  plannedCapabilities,
} from "./capabilities";

describe("dashboard capabilities", () => {
  it("reports local readiness only for an exact installed closure", () => {
    expect(assessLocalExecution("installed").state).toBe("available");
    expect(assessLocalExecution("outdated").state).toBe("needs-configuration");
    expect(assessLocalExecution("overridden")).toMatchObject({
      state: "needs-configuration",
      summary: expect.stringContaining("changed"),
    });
    expect(assessLocalExecution("add").state).toBe("needs-configuration");
  });

  it("keeps every future provider explicitly planned", () => {
    const assessments = [
      assessGitHubActionsSetup(),
      assessResidentDeployment(),
      assessHostedInference(),
      assessBringYourOwnKey(),
      assessManagedOperations(),
    ];
    expect(assessments).toEqual(plannedCapabilities);
    expect(assessments.every((assessment) => assessment.state === "planned")).toBe(true);
    expect(assessments.every((assessment) => assessment.prerequisites?.length)).toBe(true);
  });

  it("names the real resident catalog artifacts", () => {
    expect(assessResidentDeployment().prerequisites).toEqual([
      "clusters.yaml",
      "agents/<id>/deployment.yaml",
      ".github/workflows/deploy.yml",
    ]);
  });
});
