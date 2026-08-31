import workflows from "./generated/workflow-catalog.json";
import { createAuth, session } from "./worker/auth";
import { Octokit } from "@octokit/core";
import { accounts, createAgentsRepository, github, repositories, repository, tree } from "./worker/github";
import { agentsPage, organizationsPage, organizationWorkflowsPage } from "./worker/page";
import { applyPlan, buildPlan, catalogFrom, managedBundleFiles, repositorySnapshot, signPlan, verifyPlan, workflowStatuses, type WorkflowBundle } from "./worker/planner";
import { activeAccountCookie, installationReturnAccepted, readActiveAccount, viewedLogin } from "./worker/scope";
export { GitHubUserGrant } from "./worker/grant";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const publicCatalog = workflows.map(({ files: _files, ...workflow }) => workflow);
function bundle(id: string): WorkflowBundle { const found = workflows.find((workflow) => workflow.id === id); if (!found) throw new Error("Invalid workflow selection"); return found as WorkflowBundle; }
const catalog = catalogFrom(workflows as WorkflowBundle[]);

async function scoped(env: Env, request: Request) {
  const current = await session(env, request.headers);
  if (!current) return { session: null, activeAccount: null, accounts: [], viewedAccount: viewedLogin(new URL(request.url).pathname) };
  const client = await github(env, request);
  const repos = await repositories(client);
  const installed = await accounts(client, repos);
  const personal = installed.find((account) => account.type === "User")?.login ?? "";
  const activeLogin = await readActiveAccount(request.headers, installed, personal, env.AGENTS_PLAN_SIGNING_KEY);
  return { session: { user: current.user }, activeAccount: installed.find((account) => account.login === activeLogin) ?? null, accounts: installed, repositories: repos, viewedAccount: viewedLogin(new URL(request.url).pathname) };
}

async function withScopeControl(response: Response) {
  if (!response.headers.get("content-type")?.includes("text/html")) return response;
  const html = await response.text();
  const control = `<style>#outfitter-scope{position:fixed;z-index:9999;top:.75rem;right:.75rem;display:flex;align-items:center;gap:.55rem;padding:.5rem .65rem;border:1px solid #4a463e;background:#11110fee;color:#f3efe5;font:12px system-ui}#outfitter-scope a,#outfitter-scope button,#outfitter-scope select{color:#ffb36b;background:#1c1b18;border:1px solid #4a463e;padding:.32rem;font:inherit}</style><div id="outfitter-scope"><a data-signed-out href="/agents">Sign in</a><span data-viewing hidden></span><select data-accounts hidden aria-label="Active account"></select><a data-organizations hidden href="/organizations">Organizations</a></div><script>(async()=>{try{const r=await fetch('/api/scope');const s=await r.json();if(!s.session)return;const root=document.querySelector('#outfitter-scope');root.querySelector('[data-signed-out]').hidden=true;const select=root.querySelector('[data-accounts]');select.hidden=false;root.querySelector('[data-organizations]').hidden=false;for(const a of s.accounts)select.add(new Option(a.login,a.login));select.value=s.activeAccount?.login||'';select.onchange=async()=>{const r=await fetch('/api/scope',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({login:select.value})});if(r.ok)location.reload()};if(s.viewedAccount&&s.viewedAccount!==s.activeAccount?.login){const v=root.querySelector('[data-viewing]');v.hidden=false;v.textContent='Viewing '+s.viewedAccount+' / Back to '+s.activeAccount.login}}catch{}})()</script>`;
  const headers = new Headers(response.headers); headers.delete("content-length");
  return new Response(html.includes("</body>") ? html.replace("</body>", `${control}</body>`) : `${html}${control}`, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/auth/")) {
        const auth = createAuth(env);
        if (request.method === "POST" && url.pathname.endsWith("/sign-out")) { const current = await auth.api.getSession({ headers: request.headers }); const id = current?.user.githubUserId; if (typeof id === "number") await env.GITHUB_USER_GRANTS.getByName(String(id)).revoke(); }
        return auth.handler(request);
      }
      if (["/agents", "/agents/", "/install", "/install/"].includes(url.pathname)) return withScopeControl(agentsPage());
      if (url.pathname === "/organizations" || url.pathname === "/organizations/") return withScopeControl(organizationsPage(env.GITHUB_APP_SLUG));
      const orgPage = url.pathname.match(/^\/orgs\/([^/]+)\/workflows\/?$/);
      if (orgPage) return withScopeControl(organizationWorkflowsPage(decodeURIComponent(orgPage[1])));
      const installPage = url.pathname.match(/^\/orgs\/([^/]+)\/install\/?$/);
      if (installPage) return withScopeControl(agentsPage(decodeURIComponent(installPage[1])));
      if (url.pathname === "/api/scope" && request.method === "GET") return json(await scoped(env, request));
      if (url.pathname === "/api/scope" && request.method === "PUT") {
        const state = await scoped(env, request); if (!state.session) return json({ error: "Sign in required" }, 401);
        const body = await request.json<{ login: string }>(); const allowed = state.accounts.find((account) => account.login === body.login);
        if (!allowed) return json({ error: "Account is not accessible through an installation" }, 403);
        return new Response(JSON.stringify({ activeAccount: allowed }), { headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": await activeAccountCookie(allowed.login, env.AGENTS_PLAN_SIGNING_KEY) } });
      }
      if (url.pathname === "/api/organizations" && request.method === "GET") {
        const state = await scoped(env, request); if (!state.session) return json({ error: "Sign in required" }, 401);
        const client = await github(env, request);
        const values = await Promise.all(state.accounts.map(async (account) => {
          const repo = state.repositories?.find((candidate) => candidate.owner === account.login);
          let counts = { installed: 0, outdated: 0, overridden: 0 };
          if (repo) { const statuses = workflowStatuses(catalog, await repositorySnapshot(client, repo.owner, repo.name, repo.managedRoot)); counts = { installed: statuses.filter((s) => s.state === "installed").length, outdated: statuses.filter((s) => s.state === "outdated").length, overridden: statuses.filter((s) => s.state === "overridden").length }; }
          return { ...account, active: state.activeAccount?.login === account.login, private: repo?.private, counts };
        }));
        return json({ accounts: values, installationAccepted: installationReturnAccepted(url.searchParams.get("installation_id"), state.accounts) });
      }
      const orgWorkflows = url.pathname.match(/^\/api\/orgs\/([^/]+)\/workflows$/);
      if (orgWorkflows && request.method === "GET") {
        const login = decodeURIComponent(orgWorkflows[1]); const state = await scoped(env, request); const manageable = state.accounts.some((account) => account.login === login);
        const client = manageable ? await github(env, request) : new Octokit();
        let repo = manageable ? state.repositories?.find((candidate) => candidate.owner === login) : undefined;
        if (!repo) try { repo = await repository(client, login); } catch (error) { const status = (error as { status?: number }).status; if (status === 404) return json({ login, repository: null, repositoryUrl: `https://github.com/${encodeURIComponent(login)}/.agents`, manageable, workflows: publicCatalog.map((item) => ({ ...item, state: "add", action: manageable ? "add" : "none" })) }); throw error; }
        if (repo.private && !manageable) return json({ error: "Repository is private or unavailable" }, 404);
        const statuses = workflowStatuses(catalog, await repositorySnapshot(client, repo.owner, repo.name, repo.managedRoot));
        return json({ login, manageable, private: repo.private, repositoryUrl: `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`, workflows: publicCatalog.map((item) => ({ ...item, ...statuses.find((status) => status.id === item.id), action: manageable ? statuses.find((status) => status.id === item.id)?.action : "none" })) });
      }
      const orgPlans = url.pathname.match(/^\/api\/orgs\/([^/]+)\/plans$/);
      if (orgPlans && request.method === "POST") { const login = decodeURIComponent(orgPlans[1]); const state = await scoped(env, request); if (!state.accounts.some((account) => account.login === login)) return json({ error: "Account is not manageable" }, 403); const repo = state.repositories?.find((candidate) => candidate.owner === login); if (!repo) return json({ error: "No managed repository exists" }, 400); const body = await request.json<{ workflow?: string; deletes?: string[] }>(); const client = await github(env, request); const plan = await buildPlan(client, { repository: repo.fullName, managedRoot: repo.managedRoot, catalog, workflow: body.workflow, deletes: body.deletes }); return json({ plan, token: await signPlan(plan, env.AGENTS_PLAN_SIGNING_KEY) }); }
      const orgRepositories = url.pathname.match(/^\/api\/orgs\/([^/]+)\/repositories$/);
      if (orgRepositories && request.method === "POST") { const login = decodeURIComponent(orgRepositories[1]); const state = await scoped(env, request); const allowed = state.accounts.find((account) => account.login === login); if (!allowed || allowed.hasAgentsRepository) return json({ error: "Invalid account or .agents already exists" }, 400); const body = await request.json<{ workflow: string; private?: boolean }>(); const selected = bundle(body.workflow); const client = await github(env, request); return json(await createAgentsRepository(client, { account: allowed, private: body.private === true, files: await managedBundleFiles(selected), sourceSha: selected.sourceSha })); }
      if (url.pathname === "/api/agents/bootstrap") {
        const current = await session(env, request.headers); if (!current) return json({ user: null, repositories: [], catalog: [] });
        const client = await github(env, request); const repos = await repositories(client); return json({ user: current.user, repositories: repos, accounts: await accounts(client, repos), catalog: publicCatalog });
      }
      if (url.pathname === "/api/agents/repositories" && request.method === "POST") {
        const client = await github(env, request); const body = await request.json<{ account: string; workflow: string; private?: boolean }>();
        const repos = await repositories(client); const allowed = (await accounts(client, repos)).find((account) => account.login === body.account);
        if (!allowed || allowed.hasAgentsRepository) return json({ error: "Invalid account or .agents already exists" }, 400);
        const selected = bundle(body.workflow);
        return json(await createAgentsRepository(client, { account: allowed, private: body.private === true, files: await managedBundleFiles(selected), sourceSha: selected.sourceSha }));
      }
      if (url.pathname.match(/^\/api\/agents\/repositories\/[^/]+\/[^/]+$/) && request.method === "GET") {
        const [, , , , owner, repo] = url.pathname.split("/"); const client = await github(env, request); const listing = await tree(client, owner, repo, "HEAD");
        const prefix = repo === ".agents" ? "" : ".agents/"; const counts = new Map<string, number>();
        for (const entry of listing.entries) { if (entry.type !== "blob" || !entry.path.startsWith(prefix)) continue; const parts = entry.path.slice(prefix.length).split("/"); if (!['agents','skills','prompts','workflows','.outfitter'].includes(parts[0]) || !parts[1]) continue; const resource = `${prefix}${parts[0]}/${parts[1]}`; counts.set(resource, (counts.get(resource) ?? 0) + 1); }
        return json({ sha: listing.sha, resources: [...counts].map(([path, files]) => ({ path, files })).sort((a, b) => a.path.localeCompare(b.path)) });
      }
      if (url.pathname === "/api/agents/plans" && request.method === "POST") { const client = await github(env, request); const body = await request.json<{ repository: string; managedRoot: string; workflow?: string; deletes?: string[] }>(); const plan = await buildPlan(client, { repository: body.repository, managedRoot: body.managedRoot, workflow: body.workflow, deletes: body.deletes, catalog }); return json({ plan, token: await signPlan(plan, env.AGENTS_PLAN_SIGNING_KEY) }); }
      if (url.pathname === "/api/agents/apply" && request.method === "POST") { const body = await request.json<{ token: string; mode: "pull-request" | "direct" }>(); if (!['pull-request','direct'].includes(body.mode)) return json({ error: "Invalid apply mode" }, 400); const client = await github(env, request); return json(await applyPlan(client, await verifyPlan(body.token, env.AGENTS_PLAN_SIGNING_KEY), body.mode)); }
      return withScopeControl(await env.ASSETS.fetch(request));
    } catch (error) { if (error instanceof Response) return error; const message = error instanceof Error ? error.message : "Unexpected error"; return json({ error: message }, /invalid|required|expired|changed|selection/i.test(message) ? 400 : 500); }
  }
} satisfies ExportedHandler<Env>;
