import type { RepositorySnapshot, WorkflowBundle, WorkflowStatus } from "./management";

export function classifyWorkflow(bundle: WorkflowBundle, snapshot: RepositorySnapshot, accepted: boolean, sourceAvailable: boolean): WorkflowStatus {
  if (!accepted) return { id: bundle.id, state: "available", sourceSha: bundle.sourceSha };
  if (!sourceAvailable) return { id: bundle.id, state: "needs-attention", sourceSha: bundle.sourceSha, reason: "The accepted workflow's catalog source is missing." };
  const customized = bundle.files.some((file) => file.path.startsWith("agents/") && snapshot.files[file.path]);
  return { id: bundle.id, state: customized ? "customized" : "accepted", sourceSha: bundle.sourceSha };
}
