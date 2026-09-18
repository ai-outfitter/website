import { secureEqual } from "./crypto";

const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = `${ISSUER}/.well-known/jwks`;

type JsonRecord = Record<string, unknown>;

export type GitHubOidcIdentity = {
  issuer: typeof ISSUER;
  subject: string;
  repository: string;
  repositoryId: string;
  repositoryOwnerId: string;
  workflowRef: string;
  runId: string;
};

function record(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJson(value: string) {
  const decoded = new TextDecoder().decode(decodeBase64Url(value));
  const parsed: unknown = JSON.parse(decoded);
  if (!record(parsed)) throw new Error("OIDC token contains invalid JSON");
  return parsed;
}

async function audienceMatches(value: unknown, expected: string) {
  if (typeof value === "string") return await secureEqual(value, expected);
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return (await Promise.all(value.map((entry) => secureEqual(entry, expected)))).some(Boolean);
  }
  return false;
}

function bearer(request: Request) {
  const value = request.headers.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length).trim() : null;
}

export async function verifyGitHubActionsOidc(
  request: Request,
  env: Env,
  oidcFetch: typeof fetch = fetch,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<GitHubOidcIdentity | null> {
  const audience = env.PROVISIONING_OIDC_AUDIENCE?.trim();
  const expectedSubject = env.PROVISIONING_OIDC_SUBJECT?.trim();
  const expectedWorkflow = env.PROVISIONING_OIDC_WORKFLOW_REF?.trim();
  const expectedRepositoryId = env.PROVISIONING_OIDC_REPOSITORY_ID?.trim();
  const expectedOwnerId = env.PROVISIONING_OIDC_REPOSITORY_OWNER_ID?.trim();
  const token = bearer(request);
  if (!audience || !expectedSubject || !expectedWorkflow || !expectedRepositoryId || !expectedOwnerId
    || !token || token.length > 16_384) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  let header: JsonRecord;
  let claims: JsonRecord;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch { return null; }
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) return null;
  if (claims.iss !== ISSUER || typeof claims.sub !== "string" || typeof claims.repository !== "string"
    || typeof claims.repository_id !== "string" || typeof claims.repository_owner_id !== "string"
    || typeof claims.job_workflow_ref !== "string" || typeof claims.run_id !== "string") return null;
  if (!await secureEqual(claims.sub, expectedSubject)
    || !await secureEqual(claims.job_workflow_ref, expectedWorkflow)
    || !await secureEqual(claims.repository_id, expectedRepositoryId)
    || !await secureEqual(claims.repository_owner_id, expectedOwnerId)
    || !await audienceMatches(claims.aud, audience)) return null;
  const exp = Number(claims.exp);
  const nbf = claims.nbf === undefined ? null : Number(claims.nbf);
  const iat = Number(claims.iat);
  if (!Number.isSafeInteger(exp) || !Number.isSafeInteger(iat) || exp <= nowSeconds || iat > nowSeconds + 60
    || (nbf !== null && (!Number.isSafeInteger(nbf) || nbf > nowSeconds + 60))) return null;
  let jwks: unknown;
  try {
    const response = await oidcFetch(JWKS_URL, { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    jwks = await response.json();
  } catch { return null; }
  if (!record(jwks) || !Array.isArray(jwks.keys)) return null;
  const jwk = jwks.keys.find((candidate) => record(candidate) && candidate.kid === header.kid
    && candidate.kty === "RSA" && (candidate.use === undefined || candidate.use === "sig") && candidate.alg === "RS256");
  if (!record(jwk)) return null;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodeBase64Url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return null;
  } catch { return null; }
  return {
    issuer: ISSUER,
    subject: claims.sub,
    repository: claims.repository,
    repositoryId: claims.repository_id,
    repositoryOwnerId: claims.repository_owner_id,
    workflowRef: claims.job_workflow_ref,
    runId: claims.run_id,
  };
}
