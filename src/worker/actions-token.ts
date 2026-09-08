import { installationOctokit, scopedInstallationToken } from "./app";

const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const RUNNER_REPOSITORY = "ai-outfitter/factory-runner";
const RUNNER_REPOSITORY_ID = "1349964613";
const RUNNER_OWNER_ID = "294932028";
const RUNNER_ACTOR_ID = "301601005";
const RUNNER_WORKFLOW_REF = `${RUNNER_REPOSITORY}/.github/workflows/outfitter-agent.yml@refs/heads/main`;
const CLOCK_SKEW_SECONDS = 30;
const MAX_TOKEN_LIFETIME_SECONDS = 10 * 60;

type JsonRecord = Record<string, unknown>;

export type ActionsIdentity = {
  repository: string;
  repositoryId: string;
  runId: string;
  workflowRef: string;
};

export type ActionsTokenRequest = {
  repository: string;
  repositoryOwner: string;
  repositoryName: string;
  installationId: number;
  issueNumber: number;
};

export type ActionsTokenDeps = {
  verify(token: string, audience: string): Promise<ActionsIdentity>;
  covers(installationId: number, repositoryOwner: string, repositoryName: string): Promise<boolean>;
  mint(installationId: number, repositoryName: string): Promise<string>;
  targetOwner: string;
};

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid OIDC token");
  return value as JsonRecord;
}

function base64UrlBytes(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function base64UrlJson(value: string) {
  return record(JSON.parse(new TextDecoder().decode(base64UrlBytes(value))));
}

function stringClaim(claims: JsonRecord, name: string) {
  const value = claims[name];
  if (typeof value !== "string" || !value) throw new Error(`Missing OIDC claim: ${name}`);
  return value;
}

function numericClaim(claims: JsonRecord, name: string) {
  const value = claims[name];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Missing OIDC claim: ${name}`);
  return value;
}

function hasAudience(value: unknown, expected: string) {
  return value === expected;
}

export function tokenAudience(request: Pick<ActionsTokenRequest, "repository" | "installationId" | "issueNumber">) {
  return `https://ai-outfitter.com/api/actions/token:${request.repository}:issue:${request.issueNumber}:installation:${request.installationId}`;
}

export async function verifyActionsIdentity(
  token: string,
  audience: string,
  fetcher: typeof fetch = fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<ActionsIdentity> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) throw new Error("Invalid OIDC token");
  const header = base64UrlJson(parts[0]);
  const claims = base64UrlJson(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) throw new Error("Unsupported OIDC signing key");

  const response = await fetcher(JWKS_URL, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("GitHub OIDC signing keys are unavailable");
  const document = record(await response.json());
  if (!Array.isArray(document.keys)) throw new Error("Invalid GitHub OIDC signing keys");
  const key = document.keys.map(record).find((candidate) => candidate.kid === header.kid);
  if (!key || key.kty !== "RSA" || (key.alg !== undefined && key.alg !== "RS256") || (key.use !== undefined && key.use !== "sig")) {
    throw new Error("Unknown GitHub OIDC signing key");
  }
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    key as JsonWebKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    base64UrlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new Error("Invalid OIDC signature");

  const issuedAt = numericClaim(claims, "iat");
  const notBefore = numericClaim(claims, "nbf");
  const expiresAt = numericClaim(claims, "exp");
  if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS || notBefore > nowSeconds + CLOCK_SKEW_SECONDS || expiresAt <= nowSeconds - CLOCK_SKEW_SECONDS) {
    throw new Error("Expired or premature OIDC token");
  }
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TOKEN_LIFETIME_SECONDS) throw new Error("Invalid OIDC token lifetime");
  if (stringClaim(claims, "iss") !== ISSUER || !hasAudience(claims.aud, audience)) throw new Error("OIDC issuer or audience is not trusted");
  if (stringClaim(claims, "repository") !== RUNNER_REPOSITORY) throw new Error("OIDC repository is not trusted");
  if (stringClaim(claims, "repository_id") !== RUNNER_REPOSITORY_ID) throw new Error("OIDC repository identity is not trusted");
  if (stringClaim(claims, "repository_owner_id") !== RUNNER_OWNER_ID) throw new Error("OIDC repository owner is not trusted");
  if (stringClaim(claims, "actor_id") !== RUNNER_ACTOR_ID) throw new Error("OIDC dispatcher is not trusted");
  if (stringClaim(claims, "workflow_ref") !== RUNNER_WORKFLOW_REF) throw new Error("OIDC workflow is not trusted");
  if (stringClaim(claims, "ref") !== "refs/heads/main" || stringClaim(claims, "event_name") !== "workflow_dispatch") {
    throw new Error("OIDC workflow context is not trusted");
  }
  if (stringClaim(claims, "runner_environment") !== "github-hosted") throw new Error("OIDC runner environment is not trusted");

  return {
    repository: RUNNER_REPOSITORY,
    repositoryId: RUNNER_REPOSITORY_ID,
    runId: stringClaim(claims, "run_id"),
    workflowRef: RUNNER_WORKFLOW_REF,
  };
}

function parsePositiveInteger(value: unknown, name: string) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^[1-9][0-9]*$/.test(text)) throw new Error(`Invalid ${name}`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${name}`);
  return parsed;
}

export function parseActionsTokenRequest(value: unknown, targetOwner: string): ActionsTokenRequest {
  const body = record(value);
  const repository = body.repository;
  if (typeof repository !== "string") throw new Error("Invalid repository");
  const match = repository.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match || match[1].toLowerCase() !== targetOwner.toLowerCase()) throw new Error("Repository owner is not allowed");
  return {
    repository,
    repositoryOwner: match[1],
    repositoryName: match[2],
    installationId: parsePositiveInteger(body.installation_id, "installation_id"),
    issueNumber: parsePositiveInteger(body.issue_number, "issue_number"),
  };
}

function json(value: unknown, status: number) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export function actionsTokenDeps(env: Env): ActionsTokenDeps | null {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) return null;
  return {
    verify: (token, audience) => verifyActionsIdentity(token, audience),
    covers: async (installationId, repositoryOwner, repositoryName) => {
      const response = await installationOctokit(env, installationId).request("GET /repos/{owner}/{repo}", {
        owner: repositoryOwner,
        repo: repositoryName,
      });
      return String(response.data.full_name).toLowerCase() === `${repositoryOwner}/${repositoryName}`.toLowerCase();
    },
    mint: (installationId, repositoryName) => scopedInstallationToken(env, installationId, repositoryName),
    targetOwner: env.FACTORY_TARGET_OWNER?.trim() || "ai-outfitter",
  };
}

export async function exchangeActionsToken(request: Request, deps: ActionsTokenDeps | null) {
  if (!deps) return json({ error: "GitHub App credentials are not configured" }, 503);
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  if (!match) return json({ error: "A GitHub Actions OIDC token is required" }, 401);

  let target: ActionsTokenRequest;
  try {
    target = parseActionsTokenRequest(await request.json(), deps.targetOwner);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid token request" }, 400);
  }

  let identity: ActionsIdentity;
  try {
    identity = await deps.verify(match[1], tokenAudience(target));
  } catch {
    return json({ error: "GitHub Actions identity is not trusted" }, 401);
  }

  try {
    if (!(await deps.covers(target.installationId, target.repositoryOwner, target.repositoryName))) {
      return json({ error: "The App installation does not cover that repository" }, 403);
    }
  } catch {
    return json({ error: "The App installation does not cover that repository" }, 403);
  }

  try {
    const token = await deps.mint(target.installationId, target.repositoryName);
    console.log(JSON.stringify({
      message: "actions_token_minted",
      runnerRepository: identity.repository,
      runId: identity.runId,
      targetRepository: target.repository,
      issue: target.issueNumber,
    }));
    return json({ token }, 200);
  } catch (error) {
    console.error(JSON.stringify({
      message: "actions_token_mint_failed",
      runnerRepository: identity.repository,
      runId: identity.runId,
      targetRepository: target.repository,
      issue: target.issueNumber,
      error: error instanceof Error ? error.message : String(error),
    }));
    return json({ error: "The App could not mint a token for that repository" }, 403);
  }
}
