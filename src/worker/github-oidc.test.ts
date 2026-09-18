import { describe, expect, it } from "vitest";

import { verifyGitHubActionsOidc } from "./github-oidc";

const NOW = 2_000_000_000;
const env = {
  PROVISIONING_OIDC_AUDIENCE: "ai-outfitter-billing",
  PROVISIONING_OIDC_SUBJECT: "repo:Unsupervisedcom/.agents:ref:refs/heads/main",
  PROVISIONING_OIDC_WORKFLOW_REF: "Unsupervisedcom/.agents/.github/workflows/deploy.yml@refs/heads/main",
  PROVISIONING_OIDC_REPOSITORY_ID: "1318516359",
  PROVISIONING_OIDC_REPOSITORY_OWNER_ID: "36771436",
} as Env;

function base64url(value: Uint8Array | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function fixture(overrides: Record<string, unknown> = {}) {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const header = base64url(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: "https://token.actions.githubusercontent.com",
    sub: env.PROVISIONING_OIDC_SUBJECT,
    aud: env.PROVISIONING_OIDC_AUDIENCE,
    repository: "Unsupervisedcom/.agents",
    repository_id: env.PROVISIONING_OIDC_REPOSITORY_ID,
    repository_owner_id: env.PROVISIONING_OIDC_REPOSITORY_OWNER_ID,
    job_workflow_ref: env.PROVISIONING_OIDC_WORKFLOW_REF,
    run_id: "12345",
    iat: NOW - 10,
    exp: NOW + 300,
    ...overrides,
  }));
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey,
    new TextEncoder().encode(`${header}.${claims}`)));
  const token = `${header}.${claims}.${base64url(signature)}`;
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  Object.assign(jwk, { kid: "test-key", alg: "RS256", use: "sig" });
  const request = new Request("https://example.com/api/internal/provisioning/claim", {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}",
  });
  const oidcFetch = async () => Response.json({ keys: [jwk] });
  return { request, oidcFetch };
}

describe("GitHub Actions OIDC", () => {
  it("accepts a signed token only for the configured subject, audience, and workflow", async () => {
    const { request, oidcFetch } = await fixture();
    expect(await verifyGitHubActionsOidc(request, env, oidcFetch, NOW)).toEqual({
      issuer: "https://token.actions.githubusercontent.com",
      subject: env.PROVISIONING_OIDC_SUBJECT,
      repository: "Unsupervisedcom/.agents",
      repositoryId: "1318516359",
      repositoryOwnerId: "36771436",
      workflowRef: env.PROVISIONING_OIDC_WORKFLOW_REF,
      runId: "12345",
    });
  });

  for (const [name, override] of [
    ["wrong audience", { aud: "different" }],
    ["wrong subject", { sub: "repo:attacker/repo:ref:refs/heads/main" }],
    ["wrong workflow", { job_workflow_ref: "attacker/repo/workflow.yml@refs/heads/main" }],
    ["wrong repository ID", { repository_id: "999" }],
    ["wrong repository owner ID", { repository_owner_id: "999" }],
    ["expired", { exp: NOW }],
  ] as const) {
    it(`rejects ${name}`, async () => {
      const { request, oidcFetch } = await fixture(override);
      expect(await verifyGitHubActionsOidc(request, env, oidcFetch, NOW)).toBeNull();
    });
  }

  it("rejects a token whose signature is not in the issuer key set", async () => {
    const { request } = await fixture();
    expect(await verifyGitHubActionsOidc(request, env, async () => Response.json({ keys: [] }), NOW)).toBeNull();
  });
});
