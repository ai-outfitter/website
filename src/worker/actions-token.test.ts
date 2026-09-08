import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  exchangeActionsToken,
  parseActionsTokenRequest,
  tokenAudience,
  verifyActionsIdentity,
  type ActionsIdentity,
  type ActionsTokenDeps,
} from "./actions-token";

const now = 1_800_000_000;
const audience = "https://ai-outfitter.com/api/actions/token:ai-outfitter/app:issue:9:installation:42";
let privateKey: CryptoKey;
let jwk: JsonWebKey & { kid: string; alg: string; use: string };

function base64Url(value: string | ArrayBuffer) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function signedToken(overrides: Record<string, unknown> = {}) {
  const header = base64Url(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: "https://token.actions.githubusercontent.com",
    aud: audience,
    iat: now - 10,
    nbf: now - 10,
    exp: now + 300,
    repository: "ai-outfitter/factory-runner",
    repository_id: "1349964613",
    repository_owner_id: "294932028",
    actor_id: "301601005",
    workflow_ref: "ai-outfitter/factory-runner/.github/workflows/outfitter-agent.yml@refs/heads/main",
    ref: "refs/heads/main",
    event_name: "workflow_dispatch",
    runner_environment: "github-hosted",
    run_id: "12345",
    ...overrides,
  }));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${base64Url(signature)}`;
}

const identity: ActionsIdentity = {
  repository: "ai-outfitter/factory-runner",
  repositoryId: "1349964613",
  runId: "12345",
  workflowRef: "ai-outfitter/factory-runner/.github/workflows/outfitter-agent.yml@refs/heads/main",
};

function deps(overrides: Partial<ActionsTokenDeps> = {}) {
  return {
    verify: vi.fn(async () => identity),
    covers: vi.fn(async () => true),
    mint: vi.fn(async () => "installation-token"),
    targetOwner: "ai-outfitter",
    ...overrides,
  } satisfies ActionsTokenDeps;
}

function request(body: unknown, authorization = "Bearer oidc-token") {
  return new Request("https://ai-outfitter.com/api/actions/token", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  privateKey = pair.privateKey;
  jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "test-key", alg: "RS256", use: "sig" };
});

describe("verifyActionsIdentity", () => {
  const keys = async () => Response.json({ keys: [jwk] });

  it("accepts only the immutable runner and default-branch workflow identity", async () => {
    await expect(verifyActionsIdentity(await signedToken(), audience, keys, now)).resolves.toEqual(identity);
  });

  it("rejects a token for another audience, workflow, repository id, dispatcher, or time window", async () => {
    const valid = await signedToken();
    await expect(verifyActionsIdentity(valid, `${audience}:other`, keys, now)).rejects.toThrow("audience");
    await expect(verifyActionsIdentity(await signedToken({ workflow_ref: "ai-outfitter/factory-runner/.github/workflows/other.yml@refs/heads/main" }), audience, keys, now)).rejects.toThrow("workflow");
    await expect(verifyActionsIdentity(await signedToken({ repository_id: "999" }), audience, keys, now)).rejects.toThrow("repository identity");
    await expect(verifyActionsIdentity(await signedToken({ actor_id: "8276365" }), audience, keys, now)).rejects.toThrow("dispatcher");
    await expect(verifyActionsIdentity(await signedToken({ exp: now - 60 }), audience, keys, now)).rejects.toThrow("Expired");
  });

  it("rejects a token whose signature does not match its claims", async () => {
    const token = await signedToken();
    const parts = token.split(".");
    const claims = base64Url(JSON.stringify({ repository: "ai-outfitter/factory-runner" }));
    await expect(verifyActionsIdentity(`${parts[0]}.${claims}.${parts[2]}`, audience, keys, now)).rejects.toThrow("signature");
  });
});

describe("actions token request", () => {
  const body = { repository: "ai-outfitter/app", issue_number: "9", installation_id: "42" };

  it("binds the requested target into the OIDC audience before minting", async () => {
    const d = deps();
    const response = await exchangeActionsToken(request(body), d);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: "installation-token" });
    expect(d.verify).toHaveBeenCalledWith("oidc-token", tokenAudience({
      repository: "ai-outfitter/app",
      issueNumber: 9,
      installationId: 42,
    }));
    expect(d.mint).toHaveBeenCalledWith(42, "app");
    expect(d.covers).toHaveBeenCalledWith(42, "ai-outfitter", "app");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects missing identity and targets outside the configured organization", async () => {
    const d = deps();
    expect((await exchangeActionsToken(request(body, "Basic nope"), d)).status).toBe(401);
    expect((await exchangeActionsToken(request({ ...body, repository: "other/app" }), d)).status).toBe(400);
    expect(d.mint).not.toHaveBeenCalled();
  });

  it("fails closed when identity verification or installation scoping fails", async () => {
    expect((await exchangeActionsToken(request(body), deps({ verify: async () => { throw new Error("untrusted"); } }))).status).toBe(401);
    expect((await exchangeActionsToken(request(body), deps({ covers: async () => false }))).status).toBe(403);
    expect((await exchangeActionsToken(request(body), deps({ mint: async () => { throw new Error("not installed"); } }))).status).toBe(403);
  });

  it("parses only positive safe identifiers", () => {
    expect(parseActionsTokenRequest(body, "ai-outfitter")).toMatchObject({ installationId: 42, issueNumber: 9 });
    expect(() => parseActionsTokenRequest({ ...body, issue_number: "0" }, "ai-outfitter")).toThrow("issue_number");
  });
});
