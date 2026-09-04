// The GitHub App itself: webhook signature verification and installation
// credentials. Dashboard sign-in uses the App's OAuth client elsewhere; this
// file is the server-to-server half.

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";

export function appConfigured(env: Env) {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_WEBHOOK_SECRET);
}

function hex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two equal-length strings. */
function equal(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** GitHub signs the raw body with HMAC-SHA256 as `sha256=<hex>`. */
export async function verifySignature(secret: string, body: string, header: string | null) {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = `sha256=${hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))}`;
  return equal(expected, header);
}

function appAuth(env: Env) {
  return createAppAuth({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY });
}

/** A client acting as the App inside one installation, with every
 * permission the installation grants. */
export function installationOctokit(env: Env, installationId: number) {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY, installationId },
  });
}

/** A one-hour token that can act on exactly one repository. The runner
 * receives this and nothing else. */
export async function scopedInstallationToken(env: Env, installationId: number, repositoryName: string) {
  const auth = appAuth(env);
  const { token } = await auth({
    type: "installation",
    installationId,
    repositoryNames: [repositoryName],
    permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read", workflows: "write" },
  });
  return token;
}
