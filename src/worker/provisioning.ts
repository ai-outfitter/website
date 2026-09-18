import { BillingStore } from "./billing-store";
import { verifyGitHubActionsOidc, type GitHubOidcIdentity } from "./github-oidc";

const MAX_BODY_BYTES = 128_000;
// Catalog convergence includes GitHub runner startup, cloud identity exchange,
// cluster rollout, and evidence collection. Keep the lease longer than the
// reviewed deployment workflow's 30-minute timeout so a successful rollout is
// still able to submit its terminal evidence.
const CLAIM_MS = 45 * 60 * 1_000;

type ProvisioningStore = Pick<BillingStore,
  "claimPendingProvisioningOperation" | "getAccountStatus" | "recordProvisioningResult"
>;

type Options = {
  store?: ProvisioningStore;
  verify?: (request: Request, env: Env) => Promise<GitHubOidcIdentity | null>;
  now?: number;
  uuid?: () => string;
};

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function requestBody(request: Request) {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new TypeError("Request is too large");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new TypeError("Request is too large");
  const value: unknown = raw ? JSON.parse(raw) : {};
  if (!record(value)) throw new TypeError("Request body must be an object");
  return value;
}

function requiredString(value: unknown, name: string, maximum = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new TypeError(`${name} is invalid`);
  return value.trim();
}

function requiredNonNegativeInteger(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${name} is invalid`);
  return Number(value);
}

type SuccessfulProvisioningEvidence = {
  github: { repository: string; workflowRunId: string; workflowRunUrl: string };
  cluster: string;
  catalogRevision: string;
  agent: {
    name: string;
    uid: string;
    generation: number;
    observedGeneration: number;
    condition: { type: "Ready" | "Suspended"; status: "True"; observedGeneration: number };
  };
};

function successfulEvidence(
  value: Record<string, unknown>,
  authenticated: GitHubOidcIdentity,
): SuccessfulProvisioningEvidence & { desiredState: "active" | "suspended" } {
  if (!record(value.github) || !record(value.agent) || !record(value.agent.condition)) {
    throw new TypeError("Successful provisioning evidence is incomplete");
  }
  const repository = requiredString(value.github.repository, "evidence.github.repository", 200);
  const workflowRunId = requiredString(value.github.workflowRunId, "evidence.github.workflowRunId", 100);
  const workflowRunUrl = requiredString(value.github.workflowRunUrl, "evidence.github.workflowRunUrl", 500);
  if (repository !== authenticated.repository || workflowRunId !== authenticated.runId
    || workflowRunUrl !== `https://github.com/${authenticated.repository}/actions/runs/${authenticated.runId}`) {
    throw new TypeError("Provisioning evidence does not match the authenticated workflow run");
  }
  const generation = requiredNonNegativeInteger(value.agent.generation, "evidence.agent.generation");
  const observedGeneration = requiredNonNegativeInteger(
    value.agent.observedGeneration, "evidence.agent.observedGeneration",
  );
  const conditionObservedGeneration = requiredNonNegativeInteger(
    value.agent.condition.observedGeneration, "evidence.agent.condition.observedGeneration",
  );
  if (generation === 0 || observedGeneration !== generation || conditionObservedGeneration !== generation) {
    throw new TypeError("Agent evidence is not generation-matched");
  }
  const conditionType = value.agent.condition.type;
  if ((conditionType !== "Ready" && conditionType !== "Suspended")
    || value.agent.condition.status !== "True") {
    throw new TypeError("Agent evidence does not contain a successful Ready or Suspended condition");
  }
  return {
    github: { repository, workflowRunId, workflowRunUrl },
    cluster: requiredString(value.cluster, "evidence.cluster", 253),
    catalogRevision: requiredString(value.catalogRevision, "evidence.catalogRevision", 200),
    agent: {
      name: requiredString(value.agent.name, "evidence.agent.name", 253),
      uid: requiredString(value.agent.uid, "evidence.agent.uid", 253),
      generation,
      observedGeneration,
      condition: {
        type: conditionType,
        status: "True",
        observedGeneration: conditionObservedGeneration,
      },
    },
    desiredState: conditionType === "Suspended" ? "suspended" : "active",
  };
}

function workerId(identity: GitHubOidcIdentity) {
  return `github-actions:${identity.repository}:${identity.runId}`;
}

async function identity(request: Request, env: Env, options: Options) {
  return (options.verify ?? verifyGitHubActionsOidc)(request, env);
}

export async function handleProvisioningClaim(request: Request, env: Env, options: Options = {}) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const authenticated = await identity(request, env, options);
  if (!authenticated) return json({ error: "Unauthorized" }, 401);
  try { await requestBody(request); }
  catch (error) { return json({ error: error instanceof Error ? error.message : "Invalid request" }, 400); }
  const now = options.now ?? Date.now();
  const store = options.store ?? new BillingStore(env.BILLING_DB);
  const claimToken = (options.uuid ?? crypto.randomUUID.bind(crypto))();
  const operation = await store.claimPendingProvisioningOperation({
    workerId: workerId(authenticated), githubAccountId: authenticated.repositoryOwnerId,
    claimToken, claimExpiresAt: now + CLAIM_MS, now,
  });
  if (!operation) return new Response(null, { status: 204 });
  const status = await store.getAccountStatus(operation.billingAccountId);
  if (!status?.resident || (status.resident.desiredState !== "suspended"
    && !status.entitlement?.provisionEnabled)) {
    return json({ error: "Claimed provisioning state is no longer eligible" }, 409);
  }
  return json({
    operation: {
      id: operation.id,
      claimToken,
      claimExpiresAt: operation.claimExpiresAt,
      desiredRevision: operation.desiredRevision,
    },
    tenant: {
      githubAccountId: status.account.githubAccountId,
      githubAccountLogin: status.account.githubAccountLogin,
      githubAccountType: status.account.githubAccountType,
      githubInstallationId: status.account.githubInstallationId,
    },
    resident: {
      id: status.resident.id,
      agentResourceName: status.resident.agentResourceName,
      startingWorkflow: status.resident.startingWorkflow,
      desiredState: status.resident.desiredState,
      auditability: {
        required: status.subscription?.auditabilityEnabled === true,
        profile: status.resident.pensieveProfile,
        desiredState: status.resident.pensieveDesiredState,
      },
    },
  });
}

export async function handleProvisioningCallback(request: Request, env: Env, options: Options = {}) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const authenticated = await identity(request, env, options);
  if (!authenticated) return json({ error: "Unauthorized" }, 401);
  try {
    const value = await requestBody(request);
    if (typeof value.succeeded !== "boolean" || !record(value.evidence)) throw new TypeError("Callback result is invalid");
    const evidence = value.succeeded ? successfulEvidence(value.evidence, authenticated) : null;
    const observedGeneration = value.succeeded
      ? requiredNonNegativeInteger(value.observed_generation, "observed_generation") : undefined;
    const pinnedCatalogRevision = value.succeeded
      ? requiredString(value.pinned_catalog_revision, "pinned_catalog_revision") : undefined;
    if (evidence && (observedGeneration !== evidence.agent.observedGeneration
      || pinnedCatalogRevision !== evidence.catalogRevision)) {
      throw new TypeError("Top-level provisioning result does not match its evidence");
    }
    const evidenceJson = JSON.stringify(value.evidence);
    if (evidenceJson.length > 100_000) throw new TypeError("Provisioning evidence is too large");
    const auditability = value.auditability;
    if (auditability !== undefined && !record(auditability)) throw new TypeError("Auditability evidence is invalid");
    const pensieveProfile = record(auditability)
      ? requiredString(auditability.profile, "auditability.profile") : undefined;
    const pensieveEvidenceJson = record(auditability) && record(auditability.evidence)
      ? JSON.stringify(auditability.evidence) : undefined;
    if (record(auditability) && !pensieveEvidenceJson) throw new TypeError("Auditability evidence is invalid");
    if (pensieveEvidenceJson && pensieveEvidenceJson.length > 100_000) {
      throw new TypeError("Auditability evidence is too large");
    }
    const now = options.now ?? Date.now();
    const store = options.store ?? new BillingStore(env.BILLING_DB);
    const recorded = await store.recordProvisioningResult({
      operationId: requiredString(value.operation_id, "operation_id"),
      workerId: workerId(authenticated),
      claimToken: requiredString(value.claim_token, "claim_token"),
      succeeded: value.succeeded,
      evidenceJson,
      callbackIssuer: authenticated.issuer,
      callbackSubject: authenticated.subject,
      githubAccountId: authenticated.repositoryOwnerId,
      observedGeneration,
      pinnedCatalogRevision,
      agentResourceName: evidence?.agent.name,
      desiredState: evidence?.desiredState,
      personaLogin: value.succeeded && value.persona_login !== undefined
        ? requiredString(value.persona_login, "persona_login", 39) : undefined,
      pensieveProfile: value.succeeded ? pensieveProfile : undefined,
      pensieveEvidenceJson: value.succeeded ? pensieveEvidenceJson : undefined,
      error: value.succeeded ? undefined : requiredString(value.error, "error", 2_000),
      retryable: !value.succeeded && value.retryable === true,
      now,
    });
    if (!recorded) return json({ error: "Provisioning claim is stale or invalid" }, 409);
    return json({ recorded: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid callback" }, 400);
  }
}
