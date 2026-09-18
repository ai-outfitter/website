import { BillingStore } from "./billing-store";
import { verifyGitHubActionsOidc, type GitHubOidcIdentity } from "./github-oidc";

const MAX_BODY_BYTES = 128_000;
// Catalog convergence includes GitHub runner startup, cloud identity exchange,
// cluster rollout, and evidence collection. Keep the lease longer than the
// reviewed deployment workflow's 30-minute timeout so a successful rollout is
// still able to submit its terminal evidence.
const CLAIM_MS = 45 * 60 * 1_000;
const AUDIT_RETENTION_MINIMUM_MS = 29 * 24 * 60 * 60 * 1_000;
const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

type ProvisioningStore = Pick<BillingStore,
  "claimPendingProvisioningOperation" | "getAccountStatus" | "recordProvisioningResult"
>;

type Options = {
  store?: ProvisioningStore;
  verify?: (request: Request, env: Env) => Promise<GitHubOidcIdentity | null>;
  auditTrust?: { sinkId: string; publicKey: string };
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

function requiredDigest(value: unknown, name: string) {
  const digest = requiredString(value, name, 64);
  if (!HEX_64.test(digest)) throw new TypeError(`${name} is invalid`);
  return digest;
}

function requiredDigestArray(value: unknown, name: string, minimum: number) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 1_000) {
    throw new TypeError(`${name} is invalid`);
  }
  const digests = value.map((item, index) => requiredDigest(item, `${name}[${index}]`));
  if (new Set(digests).size !== digests.length) throw new TypeError(`${name} contains duplicate records`);
  return digests;
}

function requiredTime(value: unknown, name: string) {
  const text = requiredString(value, name, 100);
  const time = Date.parse(text);
  if (!Number.isFinite(time)) throw new TypeError(`${name} is invalid`);
  return { text, time };
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cannot canonicalize a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item ?? null)).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().flatMap((key) => (
      value[key] === undefined ? [] : [`${JSON.stringify(key)}:${canonicalize(value[key])}`]
    )).join(",")}}`;
  }
  throw new TypeError(`Cannot canonicalize ${typeof value}`);
}

async function canonicalDigest(value: unknown) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalize(value)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameStringSet(value: unknown, expected: string[]) {
  return Array.isArray(value) && value.length === expected.length
    && value.every((item) => typeof item === "string")
    && new Set(value).size === value.length
    && expected.every((item) => value.includes(item));
}

function base64Bytes(value: unknown, name: string, expectedLength: number) {
  const encoded = requiredString(value, name, 2_000);
  try {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    if (bytes.byteLength !== expectedLength) throw new Error("length");
    return { encoded, bytes };
  } catch {
    throw new TypeError(`${name} is invalid`);
  }
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

async function validatedAuditabilityEvidence(
  value: Record<string, unknown>, agentName: string, now: number,
  trustedSink: { sinkId: string; publicKey: string },
) {
  const sink = value.sink;
  const probe = value.traceProbe;
  if (!record(sink) || !record(probe) || !record(probe.records)
    || !record(probe.capture) || !Array.isArray(probe.recordBodies)
    || !Array.isArray(value.statements)) {
    throw new TypeError("Auditability evidence is incomplete");
  }
  const collectorRevision = requiredString(value.collectorRevision, "auditability.evidence.collectorRevision", 40);
  if (!HEX_40.test(collectorRevision)) throw new TypeError("auditability.evidence.collectorRevision is invalid");
  const oidcSubject = requiredString(value.oidcSubject, "auditability.evidence.oidcSubject", 253);
  const expectedSubject = `system:serviceaccount:agent-${agentName}:agent-runtime`;
  if (oidcSubject !== expectedSubject) throw new TypeError("Auditability evidence uses the wrong workload identity");

  const sinkId = requiredString(sink.id, "auditability.evidence.sink.id", 253);
  const sinkKeyId = requiredString(sink.keyId, "auditability.evidence.sink.keyId", 128);
  const publicKey = base64Bytes(sink.publicKey, "auditability.evidence.sink.publicKey", 32);
  if (sinkId !== trustedSink.sinkId || publicKey.encoded !== trustedSink.publicKey) {
    throw new TypeError("Auditability evidence is signed by an untrusted sink");
  }
  if (sinkKeyId !== publicKey.encoded.slice(0, 16)) {
    throw new TypeError("Auditability sink key ID does not match its public key");
  }
  if (sink.attested !== true || sink.conforming !== true || sink.mechanism !== "s3") {
    throw new TypeError("Auditability sink is not attested, conforming S3 storage");
  }

  requiredString(probe.run, "auditability.evidence.traceProbe.run", 253);
  if (probe.identity !== oidcSubject || probe.environment !== "cluster" || probe.harness !== "pi"
    || probe.installScope !== "managed") {
    throw new TypeError("Auditability trace does not come from the managed resident Pi workload");
  }
  const policyDigest = requiredString(probe.policyDigest, "auditability.evidence.traceProbe.policyDigest", 71);
  if (!/^sha256:[0-9a-f]{64}$/.test(policyDigest)) {
    throw new TypeError("Auditability trace policy digest is invalid");
  }
  const started = requiredTime(probe.startedAt, "auditability.evidence.traceProbe.startedAt");
  const completed = requiredTime(probe.completedAt, "auditability.evidence.traceProbe.completedAt");
  if (started.time > completed.time || completed.time > now + 5 * 60_000) {
    throw new TypeError("Auditability trace time window is invalid");
  }

  const records = probe.records;
  const capture = probe.capture;
  const session = requiredDigestArray(records.session, "auditability.evidence.traceProbe.records.session", 2);
  const transcript = requiredDigestArray(records.transcript, "auditability.evidence.traceProbe.records.transcript", 2);
  const modelExchange = requiredDigestArray(records.modelExchange, "auditability.evidence.traceProbe.records.modelExchange", 2);
  const toolCall = requiredDigestArray(records.toolCall, "auditability.evidence.traceProbe.records.toolCall", 2);
  const allDigests = [...session, ...transcript, ...modelExchange, ...toolCall];
  if (new Set(allDigests).size !== allDigests.length) {
    throw new TypeError("Auditability trace record classes overlap");
  }

  // Do not trust callback assertions about what the probe captured. Hash the
  // bounded synthetic record bodies exactly as Pensieve does, bind each body
  // to its claimed class, and derive completeness from the immutable bytes.
  if (probe.recordBodies.length !== allDigests.length) {
    throw new TypeError("Auditability trace does not include every record body");
  }
  const classDigests = new Map<string, string>([
    ...session.map((digest) => [digest, "session"] as const),
    ...transcript.map((digest) => [digest, "transcript"] as const),
    ...modelExchange.map((digest) => [digest, "model-exchange"] as const),
    ...toolCall.map((digest) => [digest, "tool-call"] as const),
  ]);
  const recordBodies = new Map<string, Record<string, unknown>>();
  for (const [index, body] of probe.recordBodies.entries()) {
    if (!record(body)) throw new TypeError(`auditability.evidence.traceProbe.recordBodies[${index}] is invalid`);
    const digest = await canonicalDigest(body);
    const expectedKind = classDigests.get(digest);
    if (!expectedKind || recordBodies.has(digest) || body.kind !== expectedKind) {
      throw new TypeError("Auditability trace record body does not match its digest class");
    }
    if (body.run !== probe.run || body.identity !== oidcSubject || body.environment !== "cluster"
      || body.harness !== "pi" || body.install_scope !== "managed"
      || body.policy_digest !== policyDigest) {
      throw new TypeError("Auditability trace record body has inconsistent provenance");
    }
    const created = requiredTime(body.created_at,
      `auditability.evidence.traceProbe.recordBodies[${index}].created_at`);
    if (created.time < started.time || created.time > completed.time) {
      throw new TypeError("Auditability trace record body is outside the probe window");
    }
    recordBodies.set(digest, body);
  }

  const terminalDigest = requiredDigest(capture.terminalSessionDigest,
    "auditability.evidence.traceProbe.capture.terminalSessionDigest");
  const captured = capture.captured;
  const gaps = capture.gaps;
  if (!session.includes(terminalDigest) || !Array.isArray(captured)
    || !["session", "transcript", "model-exchange", "tool-call"].every(
      (kind) => captured.includes(kind),
    ) || !Array.isArray(gaps) || gaps.length !== 0) {
    throw new TypeError("Auditability terminal capture is incomplete");
  }

  const requiredClasses = ["session", "transcript", "model-exchange", "tool-call"];
  const terminal = recordBodies.get(terminalDigest);
  const terminalCapture = terminal?.capture;
  const terminalSegment = terminal?.segment;
  if (!terminal || terminal.terminal !== true || terminal.uncommitted !== true
    || !record(terminalCapture) || terminalCapture.profile !== "resident-complete-trace-v1"
    || !sameStringSet(terminalCapture.required, requiredClasses)
    || !sameStringSet(terminalCapture.captured, requiredClasses)
    || !Array.isArray(terminalCapture.gaps) || terminalCapture.gaps.length !== 0
    || !sameStringSet(terminalSegment, allDigests.filter((digest) => digest !== terminalDigest))) {
    throw new TypeError("Auditability terminal record does not prove complete capture");
  }

  const bodies = [...recordBodies.values()];
  const sessionStart = bodies.some((body) => body.kind === "session"
    && body.terminal !== true && Array.isArray(body.argv));
  const prompt = bodies.some((body) => body.kind === "transcript"
    && body.event === "before-agent-start" && typeof body.prompt === "string" && body.prompt.length > 0
    && typeof body.system_prompt === "string" && body.system_prompt.length > 0);
  const assistant = bodies.some((body) => {
    if (body.kind !== "transcript" || body.event !== "message-end" || !record(body.message)
      || body.message.role !== "assistant" || !Array.isArray(body.message.content)) return false;
    return body.message.content.some((part) => record(part) && part.type === "text" && typeof part.text === "string")
      && body.message.content.some((part) => record(part) && part.type === "thinking"
        && typeof part.thinking === "string" && part.thinking.length > 0);
  });
  const modelRequest = bodies.some((body) => body.kind === "model-exchange"
    && body.direction === "request" && record(body.payload));
  const modelResponse = bodies.some((body) => body.kind === "model-exchange"
    && body.direction === "response-metadata" && Number.isSafeInteger(body.status)
    && Number(body.status) >= 100 && Number(body.status) <= 599 && record(body.headers));
  const calls = bodies.filter((body) => body.kind === "tool-call" && body.phase === "call"
    && typeof body.tool_call_id === "string" && body.tool_call_id.length > 0
    && typeof body.tool_name === "string" && body.tool_input !== undefined);
  const completedTool = calls.some((call) => bodies.some((body) => body.kind === "tool-call"
    && body.phase === "result" && body.tool_call_id === call.tool_call_id
    && body.tool_name === call.tool_name && body.tool_output !== undefined
    && typeof body.is_error === "boolean"));
  if (!sessionStart || !prompt || !assistant || !modelRequest || !modelResponse
    || calls.length === 0 || !completedTool) {
    throw new TypeError("Auditability record bytes do not contain a complete synthetic trace");
  }

  if (value.statements.length !== allDigests.length) {
    throw new TypeError("Auditability evidence does not cover every trace record");
  }
  const verificationKey = await crypto.subtle.importKey(
    "raw", publicKey.bytes, { name: "Ed25519" }, false, ["verify"],
  );
  const statementDigests = new Set<string>();
  for (const [index, statementValue] of value.statements.entries()) {
    if (!record(statementValue)) throw new TypeError(`auditability.evidence.statements[${index}] is invalid`);
    const digest = requiredDigest(statementValue.record_digest,
      `auditability.evidence.statements[${index}].record_digest`);
    if (statementValue.content_digest !== digest || statementValue.sink !== sinkId
      || statementValue.key_id !== sinkKeyId || statementValue.mechanism !== "s3"
      || statementValue.lock_verified !== true || statementValue.conforming !== true) {
      throw new TypeError("Auditability storage statement does not match the accepted trace");
    }
    requiredString(statementValue.locator, `auditability.evidence.statements[${index}].locator`, 2_000);
    requiredString(statementValue.object_version,
      `auditability.evidence.statements[${index}].object_version`, 1_000);
    const retention = requiredTime(statementValue.retain_until,
      `auditability.evidence.statements[${index}].retain_until`);
    if (retention.time < now + AUDIT_RETENTION_MINIMUM_MS) {
      throw new TypeError("Auditability storage retention is too short");
    }
    const issued = requiredTime(statementValue.issued_at,
      `auditability.evidence.statements[${index}].issued_at`);
    if (issued.time > now + 5 * 60_000) throw new TypeError("Auditability storage statement is future-dated");
    const signature = base64Bytes(statementValue.signature,
      `auditability.evidence.statements[${index}].signature`, 64);
    const { signature: _signature, ...unsigned } = statementValue;
    const validSignature = await crypto.subtle.verify(
      { name: "Ed25519" }, verificationKey, signature.bytes,
      new TextEncoder().encode(canonicalize(unsigned)),
    );
    if (!validSignature) throw new TypeError("Auditability storage statement signature is invalid");
    statementDigests.add(digest);
  }
  if (statementDigests.size !== allDigests.length
    || allDigests.some((digest) => !statementDigests.has(digest))) {
    throw new TypeError("Auditability storage statements do not cover the accepted trace");
  }
  // The record bytes are required only to verify the canary. Raw prompts,
  // thinking, tool payloads, and model exchanges remain in Pensieve; D1 keeps
  // their digests, signed lock statements, and the derived health summary.
  const { recordBodies: _verifiedAndDiscarded, ...traceProbeSummary } = probe;
  return { ...value, traceProbe: traceProbeSummary };
}

function workerId(identity: GitHubOidcIdentity) {
  return `github-actions:${identity.repository}:${identity.runId}`;
}

function configuredAuditTrust(env: Env) {
  const bindings = env as unknown as Record<string, unknown>;
  return {
    sinkId: requiredString(bindings.AUDITABILITY_SINK_ID, "AUDITABILITY_SINK_ID", 253),
    publicKey: requiredString(bindings.AUDITABILITY_SINK_PUBLIC_KEY, "AUDITABILITY_SINK_PUBLIC_KEY", 2_000),
  };
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
    const now = options.now ?? Date.now();
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
    if (pensieveProfile !== undefined && pensieveProfile !== "resident-complete-trace-v1") {
      throw new TypeError("Auditability profile is unsupported");
    }
    const validatedPensieveEvidence = record(auditability) && record(auditability.evidence) && evidence
      ? await validatedAuditabilityEvidence(
        auditability.evidence, evidence.agent.name, now,
        options.auditTrust ?? configuredAuditTrust(env),
      ) : undefined;
    const pensieveEvidenceJson = validatedPensieveEvidence
      ? JSON.stringify(validatedPensieveEvidence) : undefined;
    if (record(auditability) && !pensieveEvidenceJson) throw new TypeError("Auditability evidence is invalid");
    if (pensieveEvidenceJson && pensieveEvidenceJson.length > 100_000) {
      throw new TypeError("Auditability evidence is too large");
    }
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
