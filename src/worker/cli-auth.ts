import { Octokit } from "@octokit/core";
import { session } from "./auth";
import { digest, randomSecret, splitCredential, type Workspace } from "./cli-state";

const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
function fail(error: string, status = 400): never { throw reply({ error }, status); }
function enabled(env: Env) { if (env.CLI_AUTH_ENABLED !== "true") fail("not_found", 404); }
function sameOrigin(request: Request, env: Env) {
  if (request.headers.get("origin") !== new URL(env.BETTER_AUTH_URL).origin) fail("access_denied", 403);
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length")) > 4096) fail("invalid_request", 413);
  // Bound actual bytes as well: Content-Length is optional and not trusted.
  const reader = request.body?.getReader();
  if (!reader) fail("invalid_request");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4096) { await reader.cancel(); fail("invalid_request", 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_request");
    return value;
  } catch { return fail("invalid_request"); }
}
async function browserUser(request: Request, env: Env) {
  const current = await session(env, request.headers);
  const id = current?.user.githubUserId;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) fail("unauthorized", 401);
  return id;
}
async function clientFor(env: Env, id: number) {
  try { return new Octokit({ auth: await env.GITHUB_USER_GRANTS.getByName(String(id)).getAccessToken() }); }
  catch (error) {
    if ((error as { name?: string })?.name === "GitHubGrantRetryableError") return fail("temporarily_unavailable", 503);
    return fail("github_reauthorization_required", 401);
  }
}
export function authorizedMembership(membership: { state: string; role: string }, userId: string, spenders: string[]) {
  return membership.state === "active" && (membership.role === "admin" || spenders.includes(userId));
}
async function contextFor(env: Env, id: number) {
  const client = await clientFor(env, id);
  const viewer = (await client.request("GET /user")).data;
  if (viewer.id !== id) fail("unauthorized", 401);
  const userId = `github:${id}`;
  const workspaces: Workspace[] = [{ id: `user:${id}`, login: viewer.login, type: "User" }];
  // GitHub App membership permission must be granted; missing permission fails closed for orgs.
  for (let page = 1; ; page++) {
    let values;
    try { values = (await client.request("GET /user/memberships/orgs", { state: "active", per_page: 100, page })).data; }
    catch (error) { if ([403, 404].includes(Number((error as { status?: number }).status))) break; throw error; }
    for (const membership of values) {
      const org = membership.organization;
      const spenders = membership.role === "admin" ? [] : await env.CLI_DEVICES.getByName(`org:${org.id}`).spenders();
      if (authorizedMembership(membership, userId, spenders)) workspaces.push({ id: `org:${org.id}`, login: org.login, type: "Organization" });
    }
    if (values.length < 100) break;
  }
  let email: string | undefined;
  try {
    const emails = (await client.request("GET /user/emails")).data;
    email = emails.find((item) => item.verified && item.primary)?.email ?? emails.find((item) => item.verified)?.email;
  } catch { /* Email enriches analytics; its availability does not authorize inference. */ }
  if (!email) {
    try { email = await env.CLI_DEVICES.getByName(userId).email(); }
    catch { /* Optional account email may also be temporarily unavailable. */ }
  }
  return { user: { id: userId, ...(email ? { email } : {}) }, workspaces, client };
}
function bearer(request: Request) {
  const parsed = splitCredential(request.headers.get("authorization")?.replace(/^Bearer /i, ""));
  if (!parsed) fail("unauthorized", 401);
  return parsed;
}
/** Gateway entry point: resolves the selected payer and rechecks GitHub membership every request. */
export async function authenticateCli(request: Request, env: Env) {
  enabled(env);
  const credential = bearer(request);
  const device = env.CLI_DEVICES.getByName(credential.id);
  const stored = await device.authenticate(credential.secret);
  if (!stored) fail("unauthorized", 401);
  const id = Number(stored.user.id.replace(/^github:/, ""));
  const context = await contextFor(env, id);
  const workspace = context.workspaces.find((item) => item.id === stored.workspace.id);
  if (!workspace) fail("workspace_access_denied", 403);
  return { user: context.user, workspace, workspaces: context.workspaces };
}

export async function handleCli(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const route = url.pathname;
    // Existing devices must remain revocable while new sign-ins and spending are closed.
    if (!(route === "/api/cli/logout" && request.method === "POST")) enabled(env);
    if (route === "/cli/authorize" && request.method === "GET") return approvalPage(url);
    if (["/api/cli/device", "/api/cli/token", "/api/cli/approve"].includes(route)) {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      if (!await env.CLI_DEVICES.getByName(`rate:${await digest(ip)}`).rateLimit()) return reply({ error: "slow_down" }, 429);
    }
    if (route === "/api/cli/device" && request.method === "POST") {
      const id = randomSecret(10); const secret = randomSecret();
      await env.CLI_DEVICES.getByName(id).create(secret);
      return reply({ device_code: `${id}.${secret}`, user_code: id.toUpperCase(), verification_uri: `${new URL(env.BETTER_AUTH_URL).origin}/cli/authorize`, expires_in: 600, interval: 5 });
    }
    if (route === "/api/cli/token" && request.method === "POST") {
      const input = await body(request);
      const refresh = input.grant_type === "refresh_token";
      if (!refresh && input.grant_type !== "urn:ietf:params:oauth:grant-type:device_code") fail("unsupported_grant_type");
      const credential = splitCredential(refresh ? input.refresh_token : input.device_code);
      if (!credential) fail("invalid_grant");
      const result = await env.CLI_DEVICES.getByName(credential.id).exchange(credential.secret, refresh);
      if (result.error) return reply({ error: result.error }, 400);
      return reply({ access_token: `${credential.id}.${result.access}`, refresh_token: `${credential.id}.${result.refresh}`, expires_in: result.expires_in, token_type: "Bearer" });
    }
    if (route === "/api/cli/approve" && request.method === "POST") {
      sameOrigin(request, env);
      const id = await browserUser(request, env);
      const input = await body(request);
      const code = typeof input.user_code === "string" ? input.user_code.replaceAll("-", "").trim().toLowerCase() : "";
      if (!/^[a-f0-9]{20}$/.test(code) || !["approve", "deny"].includes(String(input.action))) fail("invalid_request");
      const context = await contextFor(env, id);
      const ok = await env.CLI_DEVICES.getByName(code).approve(context.user, context.workspaces[0], input.action === "deny");
      return reply(ok ? { approved: input.action === "approve" } : { error: "invalid_or_expired_code" }, ok ? 200 : 400);
    }
    if (route === "/api/cli/email" && request.method === "PUT") {
      sameOrigin(request, env);
      const id = await browserUser(request, env);
      const input = await body(request);
      if (typeof input.email !== "string" || input.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) fail("invalid_email");
      await env.CLI_DEVICES.getByName(`github:${id}`).email(input.email);
      return reply({ saved: true });
    }
    const orgRoute = route.match(/^\/api\/cli\/organizations\/(\d+)\/spenders$/);
    if (orgRoute && ["GET", "PUT"].includes(request.method)) {
      if (request.method === "PUT") sameOrigin(request, env);
      const client = await clientFor(env, await browserUser(request, env));
      const org = (await client.request("GET /organizations/{org_id}", { org_id: Number(orgRoute[1]) })).data;
      const membership = (await client.request("GET /user/memberships/orgs/{org}", { org: org.login })).data;
      if (membership.state !== "active" || membership.role !== "admin") fail("owner_required", 403);
      const store = env.CLI_DEVICES.getByName(`org:${org.id}`);
      if (request.method === "GET") return reply({ user_ids: await store.spenders() });
      const input = await body(request);
      if (!Array.isArray(input.user_ids) || input.user_ids.length > 100 || !input.user_ids.every((id) => typeof id === "string" && /^github:[1-9][0-9]*$/.test(id))) fail("invalid_user_ids");
      return reply({ user_ids: await store.spenders(input.user_ids as string[]) });
    }
    if (route === "/api/cli/logout" && request.method === "POST") {
      // Revocation remains possible after org access is lost or GitHub is unavailable.
      const token = bearer(request);
      if (!await env.CLI_DEVICES.getByName(token.id).revoke(token.secret)) fail("unauthorized", 401);
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    if (route === "/api/cli/me" && request.method === "GET") return reply(await authenticateCli(request, env));
    if (route === "/api/cli/workspace" && request.method === "PUT") {
      const token = bearer(request);
      const stored = await env.CLI_DEVICES.getByName(token.id).authenticate(token.secret);
      if (!stored) fail("unauthorized", 401);
      // Allows an explicit return to personal workspace after org authorization is removed.
      const context = await contextFor(env, Number(stored.user.id.slice(7)));
      const input = await body(request);
      const workspace = context.workspaces.find((item) => item.id === input.workspace_id);
      if (!workspace) fail("workspace_access_denied", 403);
      if (!await env.CLI_DEVICES.getByName(token.id).select(token.secret, workspace)) fail("unauthorized", 401);
      return reply({ user: context.user, workspace, workspaces: context.workspaces });
    }
    return reply({ error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof Response) return error;
    // Never reflect GitHub responses or authentication internals into client errors/logs.
    return reply({ error: "temporarily_unavailable" }, 503);
  }
}

function approvalPage(url: URL) {
  const nonce = randomSecret();
  const code = (url.searchParams.get("user_code") ?? "").replace(/[^a-fA-F0-9-]/g, "").slice(0, 24);
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize Outfitter CLI</title><body><main><h1>Authorize Outfitter CLI</h1><p>Only approve a code shown by a CLI you just started. Approval permits inference spending from your selected workspace.</p><button id="signin">Sign in with GitHub</button><form id="approval"><label>Code from your CLI <input name="user_code" required value="${code}" autocomplete="off"></label><label>Optional account email (when GitHub email is unavailable) <input name="email" type="email"></label><button name="action" value="approve">Approve this CLI</button><button name="action" value="deny">Deny</button></form><p id="status" role="status"></p></main><script nonce="${nonce}">
const status=document.getElementById('status');
document.getElementById('signin').onclick=async()=>{try{const r=await fetch('/api/auth/sign-in/social',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'github',callbackURL:location.href})});const v=await r.json();if(r.ok&&v.url)location.assign(v.url);else status.textContent='Sign-in failed. Try again.';}catch{status.textContent='Sign-in unavailable.';}};
document.getElementById('approval').onsubmit=async(e)=>{e.preventDefault();const f=new FormData(e.target);try{if(f.get('email')&&e.submitter.value==='approve'){const r=await fetch('/api/cli/email',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({email:f.get('email')})});if(!r.ok){status.textContent='Sign in before saving your email.';return;}}const r=await fetch('/api/cli/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user_code:f.get('user_code'),action:e.submitter.value})});status.textContent=r.ok?'Confirmation saved. Return to your CLI.':r.status===401?'Sign in with GitHub, then confirm again.':'Code expired, already used, or invalid. Start CLI login again.';}catch{status.textContent='Confirmation unavailable. Try again.';}};
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`, "x-content-type-options": "nosniff" } });
}
