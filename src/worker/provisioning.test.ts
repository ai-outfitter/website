import { describe, expect, it, vi } from "vitest";

import type { GitHubOidcIdentity } from "./github-oidc";
import { handleProvisioningCallback, handleProvisioningClaim } from "./provisioning";

const NOW = 2_000_000_000_000;
const identity: GitHubOidcIdentity = {
  issuer: "https://token.actions.githubusercontent.com",
  subject: "repo:Unsupervisedcom/.agents:ref:refs/heads/main",
  repository: "Unsupervisedcom/.agents",
  repositoryId: "1318516359",
  repositoryOwnerId: "123",
  workflowRef: "Unsupervisedcom/.agents/.github/workflows/deploy.yml@refs/heads/main",
  runId: "12345",
};
const env = {} as Env;
const request = (path: string, value: unknown) => new Request(`https://example.com${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
});

const successEvidence = (overrides: Record<string, unknown> = {}) => ({
  github: {
    repository: identity.repository,
    workflowRunId: identity.runId,
    workflowRunUrl: `https://github.com/${identity.repository}/actions/runs/${identity.runId}`,
  },
  cluster: "nonprod",
  catalogRevision: "abc123",
  agent: {
    name: "unsupervisedcom-luce-123",
    uid: "5e0de126-b6fa-4be4-8a17-649eb8db1dd2",
    generation: 4,
    observedGeneration: 4,
    condition: { type: "Ready", status: "True", observedGeneration: 4 },
  },
  ...overrides,
});

describe("provisioning API", () => {
  it("fails closed when GitHub OIDC does not verify", async () => {
    const store = { claimPendingProvisioningOperation: vi.fn() };
    const response = await handleProvisioningClaim(request("/claim", {}), env,
      { store: store as never, verify: async () => null, now: NOW });
    expect(response.status).toBe(401);
    expect(store.claimPendingProvisioningOperation).not.toHaveBeenCalled();
  });

  it("leases one approved operation and returns only its tenant deployment contract", async () => {
    const claimPendingProvisioningOperation = vi.fn(async () => ({
      id: "operation_1", billingAccountId: "account_1", residentId: "resident_1",
      desiredRevision: "issue-triage:v1", claimExpiresAt: NOW + 600_000,
    }));
    const store = {
      claimPendingProvisioningOperation,
      getAccountStatus: vi.fn(async () => ({
        account: { githubAccountId: "123", githubAccountLogin: "Unsupervisedcom", githubAccountType: "Organization", githubInstallationId: "456" },
        subscription: { auditabilityEnabled: true },
        entitlement: { provisionEnabled: true, auditabilityEnabled: true },
        resident: {
          id: "resident_1", agentResourceName: "unsupervisedcom-luce-123",
          startingWorkflow: "issue-triage", desiredState: "provisioning",
          pensieveProfile: "resident-complete-trace-v1", pensieveDesiredState: "provisioning",
        },
      })),
    };
    const response = await handleProvisioningClaim(request("/claim", {}), env, {
      store: store as never, verify: async () => identity, now: NOW, uuid: () => "claim-token",
    });
    expect(response.status).toBe(200);
    expect(claimPendingProvisioningOperation).toHaveBeenCalledWith({
      workerId: "github-actions:Unsupervisedcom/.agents:12345",
      githubAccountId: "123",
      claimToken: "claim-token",
      claimExpiresAt: NOW + 45 * 60_000,
      now: NOW,
    });
    expect(await response.json()).toMatchObject({
      operation: { id: "operation_1", claimToken: "claim-token" },
      tenant: { githubAccountId: "123", githubAccountLogin: "Unsupervisedcom" },
      resident: {
        agentResourceName: "unsupervisedcom-luce-123", startingWorkflow: "issue-triage",
        auditability: { required: true, profile: "resident-complete-trace-v1", desiredState: "provisioning" },
      },
    });
  });

  it("records deployment evidence only against the live claim and OIDC identity", async () => {
    const recordProvisioningResult = vi.fn(async () => true);
    const value = {
      operation_id: "operation_1", claim_token: "claim-token", succeeded: true,
      observed_generation: 4, pinned_catalog_revision: "abc123", persona_login: "luce-unsup",
      evidence: successEvidence(),
      auditability: {
        profile: "resident-complete-trace-v1",
        evidence: { collectorRevision: "abc123", oidcSubject: "system:serviceaccount:tenant:agent-runtime", traceProbe: "sha256:123" },
      },
    };
    const response = await handleProvisioningCallback(request("/callback", value), env, {
      store: { recordProvisioningResult } as never, verify: async () => identity, now: NOW,
    });
    expect(response.status).toBe(200);
    expect(recordProvisioningResult).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "operation_1",
      workerId: "github-actions:Unsupervisedcom/.agents:12345",
      claimToken: "claim-token",
      callbackIssuer: identity.issuer,
      callbackSubject: identity.subject,
      githubAccountId: "123",
      succeeded: true,
      observedGeneration: 4,
      pinnedCatalogRevision: "abc123",
      agentResourceName: "unsupervisedcom-luce-123",
      desiredState: "active",
      personaLogin: "luce-unsup",
      pensieveProfile: "resident-complete-trace-v1",
      pensieveEvidenceJson: JSON.stringify(value.auditability.evidence),
    }));
  });

  it.each([
    ["empty evidence", {}],
    ["a different workflow run", successEvidence({ github: {
      repository: identity.repository, workflowRunId: "999",
      workflowRunUrl: `https://github.com/${identity.repository}/actions/runs/999`,
    } })],
    ["a stale observed generation", successEvidence({ agent: {
      name: "unsupervisedcom-luce-123", uid: "agent-uid", generation: 4, observedGeneration: 3,
      condition: { type: "Ready", status: "True", observedGeneration: 4 },
    } })],
  ])("rejects successful callbacks with %s", async (_label, evidence) => {
    const recordProvisioningResult = vi.fn(async () => true);
    const response = await handleProvisioningCallback(request("/callback", {
      operation_id: "operation_1", claim_token: "claim-token", succeeded: true,
      observed_generation: 4, pinned_catalog_revision: "abc123", evidence,
    }), env, { store: { recordProvisioningResult } as never, verify: async () => identity, now: NOW });
    expect(response.status).toBe(400);
    expect(recordProvisioningResult).not.toHaveBeenCalled();
  });

  it("rejects duplicate top-level generation and catalog values that disagree with evidence", async () => {
    const recordProvisioningResult = vi.fn(async () => true);
    for (const input of [
      { observed_generation: 3, pinned_catalog_revision: "abc123" },
      { observed_generation: 4, pinned_catalog_revision: "different" },
    ]) {
      const response = await handleProvisioningCallback(request("/callback", {
        operation_id: "operation_1", claim_token: "claim-token", succeeded: true,
        evidence: successEvidence(), ...input,
      }), env, { store: { recordProvisioningResult } as never, verify: async () => identity, now: NOW });
      expect(response.status).toBe(400);
    }
    expect(recordProvisioningResult).not.toHaveBeenCalled();
  });

  it("maps Suspended condition evidence to the claimed suspended resident state", async () => {
    const recordProvisioningResult = vi.fn(async () => true);
    const evidence = successEvidence({ agent: {
      name: "unsupervisedcom-luce-123", uid: "agent-uid", generation: 5, observedGeneration: 5,
      condition: { type: "Suspended", status: "True", observedGeneration: 5 },
    } });
    const response = await handleProvisioningCallback(request("/callback", {
      operation_id: "operation_1", claim_token: "claim-token", succeeded: true,
      observed_generation: 5, pinned_catalog_revision: "abc123", evidence,
    }), env, { store: { recordProvisioningResult } as never, verify: async () => identity, now: NOW });
    expect(response.status).toBe(200);
    expect(recordProvisioningResult).toHaveBeenCalledWith(expect.objectContaining({
      agentResourceName: "unsupervisedcom-luce-123", desiredState: "suspended",
    }));
  });

  it("returns conflict for a stale claim without accepting its evidence", async () => {
    const response = await handleProvisioningCallback(request("/callback", {
      operation_id: "operation_1", claim_token: "stale", succeeded: false,
      error: "deployment failed", evidence: { agentReady: false },
    }), env, { store: { recordProvisioningResult: vi.fn(async () => false) } as never,
      verify: async () => identity, now: NOW });
    expect(response.status).toBe(409);
  });

  it("allows an authorized tenant workflow to claim suspension work after entitlement shutdown", async () => {
    const store = {
      claimPendingProvisioningOperation: vi.fn(async () => ({
        id: "suspend_1", billingAccountId: "account_1", residentId: "resident_1",
        desiredRevision: "resident-state:suspended:evt_1", claimExpiresAt: NOW + 600_000,
      })),
      getAccountStatus: vi.fn(async () => ({
        account: { githubAccountId: "123", githubAccountLogin: "Unsupervisedcom", githubAccountType: "Organization", githubInstallationId: "456" },
        entitlement: { provisionEnabled: false },
        resident: { id: "resident_1", agentResourceName: "unsupervisedcom-luce-123", startingWorkflow: "issue-triage", desiredState: "suspended" },
      })),
    };
    const response = await handleProvisioningClaim(request("/claim", {}), env, {
      store: store as never, verify: async () => identity, now: NOW, uuid: () => "claim-token",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resident: { desiredState: "suspended" } });
  });

  it("passes a bounded transient retry request to the tenant-scoped result recorder", async () => {
    const recordProvisioningResult = vi.fn(async () => true);
    const response = await handleProvisioningCallback(request("/callback", {
      operation_id: "operation_1", claim_token: "claim-token", succeeded: false,
      retryable: true, error: "cluster temporarily unavailable", evidence: { transient: true },
    }), env, { store: { recordProvisioningResult } as never, verify: async () => identity, now: NOW });
    expect(response.status).toBe(200);
    expect(recordProvisioningResult).toHaveBeenCalledWith(expect.objectContaining({
      githubAccountId: "123",
      retryable: true,
    }));
  });
});
