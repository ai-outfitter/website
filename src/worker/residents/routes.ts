import { authenticateCli } from "../cli-auth";
import { boundedText } from "../inference/stream";
import { record } from "../inference/models";
import { residentJson, residentFailure, validateEnrollment } from "./contracts";
import { parseResidentToken } from "./credentials";
import { ownerOptions, ownerWorkspace, triageGitHubToken, verifyInstallation } from "./github";

async function readInput(request: Request) {
  try { const value: unknown = JSON.parse(await boundedText(request, 16_384)); if (record(value)) return value; }
  catch { /* Return a stable client error without request contents. */ }
  return residentFailure("Invalid request", 400);
}
export async function residentIdentity(request: Request, env: Env) {
  if (String(env.RESIDENTS_ENABLED) !== "true") residentFailure("Residents are not enabled", 503);
  const credential = parseResidentToken(request.headers.get("authorization"));
  if (!credential) residentFailure("Invalid resident credential", 401);
  const config = await env.RESIDENT_WORKSPACES.getByName(credential.workspace).authenticate(credential.token, credential.role, credential.version);
  if (!config) residentFailure("Resident access revoked", 401);
  await verifyInstallation(env, config.workspace, config.installationId);
  return { config, role: credential.role };
}
export async function authenticateInference(request: Request, env: Env) {
  if (!/^Bearer ofr\./i.test(request.headers.get("authorization") ?? "")) return authenticateCli(request, env);
  const { config, role } = await residentIdentity(request, env);
  return { user: { id: `resident:${config.workspace.id}:${role}` }, workspace: config.workspace };
}
export async function residentRoute(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/residents/")) return null;
  try {
    const disable = path.match(/^\/api\/residents\/([^/]+)$/);
    // Owners can always revoke enrollment, including during feature closure or App removal.
    if (request.method === "DELETE" && disable) {
      if (request.headers.get("origin") !== new URL(env.BETTER_AUTH_URL).origin) residentFailure("Invalid origin", 403);
      const { workspace } = await ownerWorkspace(request, env, decodeURIComponent(disable[1]));
      return residentJson(await env.RESIDENT_WORKSPACES.getByName(workspace.id).disable());
    }
    if (String(env.RESIDENTS_ENABLED) !== "true") return residentJson({ error: "Resident triage is not enabled yet" }, 503);
    if (path === "/api/residents/github-token") {
      if (request.method !== "POST") residentFailure("Method not allowed", 405);
      const { config } = await residentIdentity(request, env);
      const input = await readInput(request);
      if (!Number.isSafeInteger(input.repository_id) || Number(input.repository_id) <= 0) residentFailure("Repository ID required");
      return residentJson(await triageGitHubToken(env, config, Number(input.repository_id)));
    }
    const match = path.match(/^\/api\/residents\/([^/]+)$/);
    if (!match || !["GET", "PUT", "DELETE"].includes(request.method)) residentFailure("Method not allowed", 405);
    if (request.method !== "GET" && request.headers.get("origin") !== new URL(env.BETTER_AUTH_URL).origin) residentFailure("Invalid origin", 403);
    const options = await ownerOptions(request, env, decodeURIComponent(match[1]));
    const store = env.RESIDENT_WORKSPACES.getByName(options.workspace.id);
    if (request.method === "GET") return residentJson({ ...options, status: await store.status() });
    const input = await readInput(request);
    if (Object.keys(input).some((key) => !["repository_ids", "projectManagerName", "engineerName"].includes(key)) || !Array.isArray(input.repository_ids) || !input.repository_ids.length || input.repository_ids.some((id) => !Number.isSafeInteger(id)) || new Set(input.repository_ids).size !== input.repository_ids.length || typeof input.projectManagerName !== "string" || typeof input.engineerName !== "string") residentFailure("Select repositories and name both residents");
    const selected = options.repositories.filter((repo) => (input.repository_ids as unknown[]).includes(repo.id));
    if (selected.length !== input.repository_ids.length) residentFailure("Repository selection is not authorized", 403);
    const enrollment = { workspace: options.workspace, installationId: options.installationId, repositories: selected, projectManagerName: input.projectManagerName, engineerName: input.engineerName };
    try { validateEnrollment(enrollment); } catch { residentFailure("Invalid resident names or repository selection"); }
    return residentJson(await store.enroll(enrollment), 202);
  } catch (error) {
    if (error instanceof Response) return error;
    if ([401, 403, 404].includes(Number((error as { status?: number })?.status))) return residentJson({ error: "GitHub access unavailable; reconnect or check the App installation" }, 403);
    return residentJson({ error: "Resident service temporarily unavailable" }, 503);
  }
}
