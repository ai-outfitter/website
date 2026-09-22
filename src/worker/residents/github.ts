import { Octokit } from "@octokit/core";
import { createAppAuth } from "@octokit/auth-app";
import { session } from "../auth";
import { github } from "../github";
import { installationOctokit } from "../app";
import { residentFailure, type ResidentConfiguration, type SelectedRepository } from "./contracts";
import type { Workspace } from "../cli-state";

function app(env: Env) { return new Octokit({ authStrategy: createAppAuth, auth: { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY } }); }
export async function verifyInstallation(env: Env, workspace: Workspace, installationId: number) {
  const { data } = await app(env).request("GET /app/installations/{installation_id}", { installation_id: installationId });
  if (!data.account || String(data.account.id) !== workspace.id.split(":")[1] || data.suspended_at || !("login" in data.account) || data.account.login.toLowerCase() !== workspace.login.toLowerCase()) residentFailure("Installation access is unavailable", 403);
}
/** Owner account discovery remains available without any App installation. */
export async function ownerAccounts(request: Request, env: Env) {
  const current = await session(env, request.headers);
  if (!current?.user.githubUserId) residentFailure("Sign in required", 401);
  const client = await github(env, request);
  const viewer = (await client.request("GET /user")).data;
  if (Number(viewer.id) !== current.user.githubUserId) residentFailure("Identity mismatch", 403);
  const accounts = [{ login: viewer.login, type: "User" }];
  for (let page = 1; ; page++) {
    const batch = (await client.request("GET /user/memberships/orgs", { state: "active", per_page: 100, page })).data;
    for (const item of batch) if (item.state === "active" && item.role === "admin") accounts.push({ login: item.organization.login, type: "Organization" });
    if (batch.length < 100) break;
  }
  return { accounts };
}
export async function ownerWorkspace(request: Request, env: Env, login: string) {
  const current = await session(env, request.headers);
  if (!current?.user.githubUserId) residentFailure("Sign in required", 401);
  const client = await github(env, request);
  const owner = (await client.request("GET /users/{username}", { username: login })).data;
  if (owner.type === "User") {
    if (owner.id !== current.user.githubUserId) residentFailure("Account owner required", 403);
  } else if (owner.type === "Organization") {
    const membership = (await client.request("GET /user/memberships/orgs/{org}", { org: login })).data;
    if (membership.role !== "admin" || membership.state !== "active") residentFailure("Organization owner required", 403);
  } else residentFailure("Unsupported account", 403);
  const workspace: Workspace = { id: `${owner.type === "User" ? "user" : "org"}:${owner.id}`, login: owner.login, type: owner.type as "User" | "Organization" };
  return { workspace, client, ownerId: owner.id };
}
export async function ownerOptions(request: Request, env: Env, login: string) {
  const { workspace, client, ownerId } = await ownerWorkspace(request, env, login);
  let installationId: number | undefined;
  for (let page = 1; ; page++) {
    const data = (await client.request("GET /user/installations", { page, per_page: 100 })).data.installations;
    const installation = data.find((item) => item.account?.id === ownerId);
    if (installation) { installationId = installation.id; break; }
    if (data.length < 100) break;
  }
  if (!installationId) residentFailure("Install the Outfitter GitHub App for this account first", 403);
  await verifyInstallation(env, workspace, installationId);
  const installation = installationOctokit(env, installationId);
  const repositories: SelectedRepository[] = [];
  for (let page = 1; ; page++) {
    const batch = (await installation.request("GET /installation/repositories", { page, per_page: 100 })).data.repositories;
    for (const repo of batch) if (repo.owner.id === ownerId && !repo.archived && !repo.disabled && Number.isSafeInteger(Number(repo.id))) repositories.push({ id: Number(repo.id), fullName: repo.full_name });
    if (batch.length < 100) break;
  }
  return { workspace, installationId, repositories };
}
export async function verifyRepositoryScope(env: Env, config: ResidentConfiguration, repositoryId: number) {
  const selected = config.repositories.find((repo) => repo.id === repositoryId);
  if (!selected) residentFailure("Repository is not enabled", 403);
  await verifyInstallation(env, config.workspace, config.installationId);
  const repo = (await installationOctokit(env, config.installationId).request("GET /repositories/{repository_id}", { repository_id: repositoryId })).data;
  if (repo.owner.id !== Number(config.workspace.id.split(":")[1]) || repo.full_name !== selected.fullName) residentFailure("Repository scope changed; re-enroll it", 403);
}
export async function triageGitHubToken(env: Env, config: ResidentConfiguration, repositoryId: number) {
  await verifyRepositoryScope(env, config, repositoryId);
  const auth = createAppAuth({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY });
  const result = await auth({ type: "installation", installationId: config.installationId, repositoryIds: [repositoryId], permissions: { contents: "read", issues: "write", metadata: "read" } });
  return { token: result.token, expires_at: result.expiresAt };
}
