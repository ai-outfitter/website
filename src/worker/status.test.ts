import { describe, expect, it } from "vitest";
import { classifyWorkflow } from "./status";
import type { RepositorySnapshot, WorkflowBundle } from "./management";

const workflow: WorkflowBundle = { id: "review", sourceRepository: "ai-outfitter/community-profiles", sourceSha: "new", files: [
  { path: "workflows/review/workflow.yaml", content: "id: review", mode: "100644", sha256: "declaration", blobSha: "blob-declaration" },
  { path: "agents/reviewer/agent.md", content: "review", mode: "100644", sha256: "agent", blobSha: "blob-agent" },
] };
const snapshot = (files: RepositorySnapshot["files"]): RepositorySnapshot => ({ sha: "head", files });

describe("workflow repository status", () => {
  it("separates availability, acceptance, customization, and attention", () => {
    expect(classifyWorkflow(workflow, snapshot({}), false, true).state).toBe("available");
    expect(classifyWorkflow(workflow, snapshot({}), true, true).state).toBe("accepted");
    expect(classifyWorkflow(workflow, snapshot({ "agents/reviewer/agent.md": { mode: "100644", blobSha: "local" } }), true, true).state).toBe("customized");
    expect(classifyWorkflow(workflow, snapshot({}), true, false).state).toBe("needs-attention");
  });
});
