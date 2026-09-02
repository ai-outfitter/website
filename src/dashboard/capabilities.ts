export type CapabilityState = "available" | "needs-configuration" | "planned";

export type CapabilityAssessment = {
  id: string;
  title: string;
  state: CapabilityState;
  summary: string;
  prerequisites?: string[];
};

export type EnabledWorkflowState = "available" | "enabled" | "customized" | "needs-attention" | undefined;

export function assessLocalExecution(state: EnabledWorkflowState): CapabilityAssessment {
  if (state === "enabled" || state === "customized") {
    return {
      id: "local-execution",
      title: "Run locally",
      state: "available",
      summary: "The enabled workflow is ready for Outfitter to resolve locally.",
    };
  }

  const reason = state === "needs-attention"
    ? "The enabled workflow has a missing or invalid dependency."
    : "Enable a workflow in this account's .agents repository first.";

  return {
    id: "local-execution",
    title: "Run locally",
    state: "needs-configuration",
    summary: reason,
  };
}

export function assessGitHubActionsSetup(): CapabilityAssessment {
  // TODO(capability:github-actions-setup): generate least-privilege workflow files
  // only after workload-repository writes become an explicit product boundary.
  return {
    id: "github-actions-setup",
    title: "Configure GitHub Actions",
    state: "planned",
    summary: "Generate thin, least-privilege workflow plumbing in workload repositories.",
    prerequisites: ["A versioned Actions setup contract", "Explicit workload-repository write access"],
  };
}

export function assessResidentDeployment(): CapabilityAssessment {
  // TODO(capability:resident-deployment): inspect and plan the catalog deployment
  // contract after Agent Operator exposes a stable setup/readiness interface.
  return {
    id: "resident-deployment",
    title: "Deploy resident agents",
    state: "planned",
    summary: "Manage catalog deployment declarations without operating the cluster from this website.",
    prerequisites: ["clusters.yaml", "agents/<id>/deployment.yaml", ".github/workflows/deploy.yml"],
  };
}

export function assessHostedInference(): CapabilityAssessment {
  // TODO(capability:hosted-inference): broker scoped, revocable credentials before
  // connecting the dashboard to hosted inference. Never expose shared Spark auth.
  return {
    id: "hosted-inference",
    title: "Hosted inference",
    state: "planned",
    summary: "Use AI Outfitter-managed inference without placing provider credentials in repositories.",
    prerequisites: ["Scoped credential broker", "Per-account authorization and revocation"],
  };
}

export function assessBringYourOwnKey(): CapabilityAssessment {
  // TODO(capability:byok-inference): add encrypted provider credentials only with
  // an explicit storage, rotation, deletion, and runtime-delivery contract.
  return {
    id: "byok-inference",
    title: "Bring your own key",
    state: "planned",
    summary: "Select a provider while keeping customer credentials encrypted and out of Git.",
    prerequisites: ["Encrypted credential storage", "Rotation and deletion lifecycle"],
  };
}

export function assessManagedOperations(): CapabilityAssessment {
  // TODO(capability:managed-operations): consume an operator-owned execution and
  // status API; do not infer runtime state from repository configuration alone.
  return {
    id: "managed-operations",
    title: "Managed operations",
    state: "planned",
    summary: "Inspect runs, readiness, and failures after the runtime exposes an authoritative status contract.",
    prerequisites: ["Operator execution API", "Authoritative per-account runtime status"],
  };
}

export const plannedCapabilities = [
  assessGitHubActionsSetup(),
  assessResidentDeployment(),
  assessHostedInference(),
  assessBringYourOwnKey(),
  assessManagedOperations(),
] satisfies CapabilityAssessment[];
