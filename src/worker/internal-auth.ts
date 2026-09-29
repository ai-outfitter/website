import { Octokit } from "@octokit/core";
import { session } from "./auth";
import { digest, randomSecret, splitCredential, type InternalIdentity } from "./internal-device-state";

const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
function fail(error: string, status = 400): never { throw reply({ error }, status); }
function enabled(env: Env) { if (env.INTERNAL_INFERENCE_ENABLED !== "true") fail("not_found", 404); }
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
function internalUser(env: Env, user: InternalIdentity) {
  if (!(env.INTERNAL_USERS ?? "").split(",").map((value) => value.trim()).includes(user.id)) fail("internal_access_required", 403);
  return { user };
}
async function browserIdentity(request: Request, env: Env) {
  const id = await browserUser(request, env);
  // Check entitlement before requesting the durable GitHub grant.
  internalUser(env, { id: `github:${id}`, login: "" });
  const client = await clientFor(env, id);
  const viewer = (await client.request("GET /user")).data;
  if (viewer.id !== id) fail("unauthorized", 401);
  return internalUser(env, { id: `github:${id}`, login: viewer.login, ...(viewer.name ? { name: viewer.name } : {}) });
}
function bearer(request: Request) {
  const match = request.headers.get("authorization")?.match(/^Bearer (.+)$/i);
  const parsed = splitCredential(match?.[1]);
  if (!parsed) fail("unauthorized", 401);
  return parsed;
}
/** Browser sessions and revocable device credentials share the same internal entitlement. */
export async function authenticateInternal(request: Request, env: Env) {
  enabled(env);
  if (!request.headers.has("authorization")) return browserIdentity(request, env);
  const credential = bearer(request);
  const stored = await env.INTERNAL_DEVICES.getByName(credential.id).authenticate(credential.secret);
  if (!stored) fail("unauthorized", 401);
  return internalUser(env, stored.user);
}

export async function handleInternalAuth(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const route = url.pathname;
    // Existing devices remain revocable while internal access is disabled.
    if (!(route === "/api/cli/logout" && request.method === "POST")) enabled(env);
    if (route === "/internal/authorize" && request.method === "GET") return approvalPage(url);
    if (["/api/cli/device", "/api/cli/token", "/api/cli/approve"].includes(route)) {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      if (!await env.INTERNAL_DEVICES.getByName(`rate:${await digest(ip)}`).rateLimit()) return reply({ error: "slow_down" }, 429);
    }
    if (route === "/api/cli/device" && request.method === "POST") {
      const id = randomSecret(10); const secret = randomSecret();
      await env.INTERNAL_DEVICES.getByName(id).create(secret);
      return reply({ device_code: `${id}.${secret}`, user_code: id.toUpperCase(), verification_uri: `${new URL(env.BETTER_AUTH_URL).origin}/internal/authorize`, expires_in: 600, interval: 5 });
    }
    if (route === "/api/cli/token" && request.method === "POST") {
      const input = await body(request);
      const refresh = input.grant_type === "refresh_token";
      if (!refresh && input.grant_type !== "urn:ietf:params:oauth:grant-type:device_code") fail("unsupported_grant_type");
      const credential = splitCredential(refresh ? input.refresh_token : input.device_code);
      if (!credential) fail("invalid_grant");
      const result = await env.INTERNAL_DEVICES.getByName(credential.id).exchange(credential.secret, refresh);
      if (result.error) return reply({ error: result.error }, 400);
      const device = env.INTERNAL_DEVICES.getByName(credential.id);
      const authenticated = await device.authenticate(result.access!);
      if (!authenticated) fail("invalid_grant");
      try { internalUser(env, authenticated.user); }
      catch (error) { await device.revoke(result.access!); throw error; }
      return reply({ access_token: `${credential.id}.${result.access}`, refresh_token: `${credential.id}.${result.refresh}`, expires_in: result.expires_in, token_type: "Bearer" });
    }
    if (route === "/api/cli/approve" && request.method === "POST") {
      sameOrigin(request, env);
      const context = await browserIdentity(request, env);
      const input = await body(request);
      const code = typeof input.user_code === "string" ? input.user_code.replaceAll("-", "").trim().toLowerCase() : "";
      if (!/^[a-f0-9]{20}$/.test(code) || !["approve", "deny"].includes(String(input.action))) fail("invalid_request");
      const ok = await env.INTERNAL_DEVICES.getByName(code).approve(context.user, input.action === "deny");
      return reply(ok ? { approved: input.action === "approve" } : { error: "invalid_or_expired_code" }, ok ? 200 : 400);
    }
    if (route === "/api/cli/logout" && request.method === "POST") {
      // Revocation remains possible after internal access is lost or GitHub is unavailable.
      const token = bearer(request);
      if (!await env.INTERNAL_DEVICES.getByName(token.id).revoke(token.secret)) fail("unauthorized", 401);
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    if (route === "/api/cli/me" && request.method === "GET") return reply(await authenticateInternal(request, env));
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
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize Outfitter CLI</title><body><main><h1>Authorize Outfitter CLI</h1><p>Only approve a code shown by a CLI you just started. Approval permits access to internal DGX Spark inference.</p><button id="signin">Sign in with GitHub</button><form id="approval"><label>Code from your CLI <input name="user_code" required value="${code}" autocomplete="off"></label><button name="action" value="approve">Approve this CLI</button><button name="action" value="deny">Deny</button></form><p id="status" role="status"></p></main><script nonce="${nonce}">
const status=document.getElementById('status'),signin=document.getElementById('signin'),form=document.getElementById('approval'),input=form.elements.user_code;
const buttons=[...form.querySelectorAll('button')];
buttons.forEach(button=>button.disabled=true);
async function checkIdentity(){
  status.textContent='Checking sign-in…';
  try{
    const r=await fetch('/api/cli/me',{cache:'no-store'}),v=await r.json();
    if(r.ok){signin.hidden=true;status.textContent='Signed in as '+v.user.login+'. Confirm the code from your CLI.';buttons.forEach(button=>button.disabled=false);}
    else if(r.status===401){signin.hidden=false;status.textContent=new URL(location.href).searchParams.has('error')?'GitHub sign-in did not finish. Start again here in this tab; do not reload the GitHub callback.':'Sign in with GitHub to approve this CLI.';}
    else status.textContent=r.status===403?'Your GitHub account does not have internal inference access.':'Sign-in could not be checked. Reload this page to retry.';
  }catch{status.textContent='Sign-in could not be checked. Reload this page to retry.';}
}
signin.onclick=async()=>{
  if(signin.disabled)return;
  signin.disabled=true;
  const callback=new URL(location.href);callback.search='';callback.searchParams.set('user_code',input.value.trim());
  history.replaceState(null,'',callback);
  try{
    const r=await fetch('/api/auth/sign-in/social',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'github',callbackURL:callback.href,errorCallbackURL:callback.href})}),v=await r.json();
    if(r.ok&&v.url){status.textContent='Opening GitHub…';location.assign(v.url);}
    else{status.textContent='Sign-in failed. Try again.';signin.disabled=false;}
  }catch{status.textContent='Sign-in unavailable. Try again.';signin.disabled=false;}
};
form.onsubmit=async(e)=>{
  e.preventDefault();buttons.forEach(button=>button.disabled=true);
  try{
    const r=await fetch('/api/cli/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user_code:input.value,action:e.submitter.value})});
    if(r.ok){status.textContent='Confirmation saved. Return to your CLI.';return;}
    if(r.status===401){await checkIdentity();return;}
    status.textContent=r.status===403?'Your account cannot approve this CLI.':'Code expired, already used, or invalid. Start CLI login again.';
  }catch{status.textContent='Confirmation unavailable. Try again.';}
  buttons.forEach(button=>button.disabled=false);
};
checkIdentity();
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`, "x-content-type-options": "nosniff" } });
}
