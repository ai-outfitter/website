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

const auditKeys = crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const auditTrust = async () => {
  const keys = await auditKeys as CryptoKeyPair;
  return {
    sinkId: "pensieve.example.com",
    publicKey: Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("base64"),
  };
};
const canonicalize = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item ?? null)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().flatMap((key) => (
    object[key] === undefined ? [] : [`${JSON.stringify(key)}:${canonicalize(object[key])}`]
  )).join(",")}}`;
};
const canonicalDigest = async (value: unknown) => Buffer.from(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalize(value))),
).toString("hex");

const auditEvidence = async (
  overrides: Record<string, unknown> = {},
  options: { exposedThinking?: boolean } = {},
) => {
  const oidcSubject = "system:serviceaccount:agent-unsupervisedcom-luce-123:agent-runtime";
  const policyDigest = `sha256:${"b".repeat(64)}`;
  const base = (kind: string, offset: number) => ({
    kind, run: "run-1", attempt: 1, identity: oidcSubject, environment: "cluster",
    policy_digest: policyDigest, created_at: new Date(NOW - 60_000 + offset).toISOString(),
    install_scope: "managed", harness: "pi", harness_version: "test",
    event_surface: "extension:in-process",
  });
  const nonterminal = [
    { ...base("session", 0), argv: ["--print", "audit probe"] },
    {
      ...base("transcript", 1_000), event: "before-agent-start", prompt: "audit probe",
      system_prompt: "You are the resident audit probe.", system_prompt_options: { agent: "luce" },
    },
    {
      ...base("transcript", 2_000), event: "message-end",
      message: {
        role: "assistant",
        content: [
          ...(options.exposedThinking === false ? [] : [{ type: "thinking", thinking: "inspect the probe" }]),
          { type: "text", text: "Running the audit probe." },
        ],
      },
    },
    {
      ...base("model-exchange", 3_000), direction: "request",
      payload: { model: "audit-probe", messages: [{ role: "user", content: "audit probe" }] },
    },
    {
      ...base("model-exchange", 4_000), direction: "response-metadata", status: 200,
      headers: { "x-request-id": "probe-request-1" },
    },
    {
      ...base("tool-call", 5_000), phase: "call", tool_call_id: "probe-tool-1",
      tool_name: "audit_probe", tool_input: { value: "ping" },
    },
    {
      ...base("tool-call", 6_000), phase: "result", tool_call_id: "probe-tool-1",
      tool_name: "audit_probe", tool_input: { value: "ping" },
      tool_output: [{ type: "text", text: "pong" }], tool_details: { exitCode: 0 }, is_error: false,
    },
  ];
  const nonterminalDigests = await Promise.all(nonterminal.map((body) => canonicalDigest(body)));
  const requiredClasses = ["session", "transcript", "model-exchange", "tool-call"];
  const terminal = {
    ...base("session", 7_000), terminal: true, uncommitted: true,
    segment: nonterminalDigests, captured: requiredClasses,
    capture: {
      profile: "resident-complete-trace-v1", required: requiredClasses,
      captured: requiredClasses, gaps: [],
    },
  };
  const terminalDigest = await canonicalDigest(terminal);
  const digests = [...nonterminalDigests, terminalDigest];
  const recordBodies = [...nonterminal, terminal];
  const keys = await auditKeys as CryptoKeyPair;
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("base64");
  const keyId = publicKey.slice(0, 16);
  const statements = await Promise.all(digests.map(async (digest, index) => {
    const unsigned = {
      record_digest: digest, content_digest: digest,
      locator: `s3://bucket/records/${digest}.json`, object_version: `version-${index}`,
      sink: "pensieve.example.com", key_id: keyId,
      mechanism: "s3", retain_until: new Date(NOW + 30 * 24 * 60 * 60_000).toISOString(),
      lock_verified: true, conforming: true, issued_at: new Date(NOW).toISOString(),
    };
    const signature = await crypto.subtle.sign(
      { name: "Ed25519" }, keys.privateKey, new TextEncoder().encode(canonicalize(unsigned)),
    );
    return { ...unsigned, signature: Buffer.from(signature).toString("base64") };
  }));
  return {
    collectorRevision: "a".repeat(40),
    oidcSubject,
    sink: {
      id: "pensieve.example.com", keyId, publicKey,
      attested: true, conforming: true, mechanism: "s3",
    },
    traceProbe: {
      run: "run-1", identity: oidcSubject, environment: "cluster", harness: "pi",
      installScope: "managed", policyDigest,
      startedAt: new Date(NOW - 70_000).toISOString(), completedAt: new Date(NOW).toISOString(),
      records: {
        session: [digests[0], terminalDigest], transcript: digests.slice(1, 3),
        modelExchange: digests.slice(3, 5), toolCall: digests.slice(5, 7),
      },
      recordBodies,
      capture: {
        terminalSessionDigest: terminalDigest,
        captured: ["session", "transcript", "model-exchange", "tool-call"], gaps: [],
      },
    },
    statements,
    ...overrides,
  };
};

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
        evidence: await auditEvidence(),
      },
    };
    const response = await handleProvisioningCallback(request("/callback", value), env, {
      store: { recordProvisioningResult } as never, verify: async () => identity,
      auditTrust: await auditTrust(), now: NOW,
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
    }));
    const stored = recordProvisioningResult.mock.calls[0]?.[0];
    const storedAudit = JSON.parse(String(stored?.pensieveEvidenceJson));
    expect(storedAudit.traceProbe.recordBodies).toBeUndefined();
    expect(storedAudit.traceProbe.records).toEqual(value.auditability.evidence.traceProbe.records);
    expect(storedAudit.statements).toEqual(value.auditability.evidence.statements);
  });

  it("rejects a correctly self-signed statement from a sink the Worker does not trust", async () => {
    const recordProvisioningResult = vi.fn(async () => true);
    const response = await handleProvisioningCallback(request("/callback", {
      operation_id: "operation_1", claim_token: "claim-token", succeeded: true,
      observed_generation: 4, pinned_catalog_revision: "abc123", evidence: successEvidence(),
      auditability: { profile: "resident-complete-trace-v1", evidence: await auditEvidence() },
    }), env, {
      store: { recordProvisioningResult } as never, verify: async () => identity, now: NOW,
      auditTrust: { sinkId: "different.pensieve.example.com", publicKey: Buffer.alloc(32).toString("base64") },
    });
    expect(response.status).toBe(400);
    expect(recordProvisioningResult).not.toHaveBeenCalled();
  });

  it.each([
    ["an advisory collector", async () => {
      const evidence = await auditEvidence();
      return { ...evidence, traceProbe: { ...evidence.traceProbe, installScope: "session" } };
    }],
    ["a different workload identity", async () => auditEvidence({
      oidcSubject: "system:serviceaccount:other:agent-runtime",
    })],
    ["missing exposed thinking", async () => auditEvidence({}, { exposedThinking: false })],
    ["a record body changed after storage", async () => {
      const evidence = await auditEvidence();
      return { ...evidence, traceProbe: {
        ...evidence.traceProbe,
        recordBodies: evidence.traceProbe.recordBodies.map((body, index) => (
          index === 0 ? { ...body, argv: ["tampered"] } : body
        )),
      } };
    }],
    ["a declared capture gap", async () => {
      const evidence = await auditEvidence();
      return { ...evidence, traceProbe: {
        ...evidence.traceProbe,
        capture: { ...evidence.traceProbe.capture, gaps: ["model-exchange"] },
      } };
    }],
    ["an unlocked statement", async () => {
      const evidence = await auditEvidence();
      return { ...evidence, statements: evidence.statements.map((statement, index) => (
        index === 0 ? { ...statement, lock_verified: false } : statement
      )) };
    }],
    ["a forged storage signature", async () => {
      const evidence = await auditEvidence();
      const forged = Buffer.alloc(64, 7).toString("base64");
      return { ...evidence, statements: evidence.statements.map((statement, index) => (
        index === 0 ? { ...statement, signature: forged } : statement
      )) };
    }],
  ])("rejects enterprise audit evidence with %s", async (_label, makeEvidence) => {
    const recordProvisioningResult = vi.fn(async () => true);
    const response = await handleProvisioningCallback(request("/callback", {
      operation_id: "operation_1", claim_token: "claim-token", succeeded: true,
      observed_generation: 4, pinned_catalog_revision: "abc123", evidence: successEvidence(),
      auditability: { profile: "resident-complete-trace-v1", evidence: await makeEvidence() },
    }), env, {
      store: { recordProvisioningResult } as never, verify: async () => identity,
      auditTrust: await auditTrust(), now: NOW,
    });
    expect(response.status).toBe(400);
    expect(recordProvisioningResult).not.toHaveBeenCalled();
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
