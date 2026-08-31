import workflows from "./generated/workflow-catalog.json";
import { createAuth, session } from "./worker/auth";
import { accounts, createAgentsRepository, github, repositories, tree } from "./worker/github";
import { agentsPage } from "./worker/page";
import { applyPlan, buildPlan, managedBundleFiles, signPlan, verifyPlan, type WorkflowBundle } from "./worker/planner";
export { GitHubUserGrant } from "./worker/grant";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const publicCatalog = workflows.map(({ files: _files, ...workflow }) => workflow);
function bundle(id: string): WorkflowBundle { const found = workflows.find((workflow) => workflow.id === id); if (!found) throw new Error("Invalid workflow selection"); return found as WorkflowBundle; }

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/auth/")) {
        const auth = createAuth(env);
        if (request.method === "POST" && url.pathname.endsWith("/sign-out")) { const current = await auth.api.getSession({ headers: request.headers }); const id = current?.user.githubUserId; if (typeof id === "number") await env.GITHUB_USER_GRANTS.getByName(String(id)).revoke(); }
        return auth.handler(request);
      }
      if (["/agents", "/agents/", "/install", "/install/"].includes(url.pathname)) return agentsPage();
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
      if (url.pathname === "/api/agents/plans" && request.method === "POST") { const client = await github(env, request); const body = await request.json<{ repository: string; managedRoot: string; workflow: string; deletes?: string[] }>(); const plan = await buildPlan(client, { ...body, bundle: bundle(body.workflow) }); return json({ plan, token: await signPlan(plan, env.AGENTS_PLAN_SIGNING_KEY) }); }
      if (url.pathname === "/api/agents/apply" && request.method === "POST") { const body = await request.json<{ token: string; mode: "pull-request" | "direct" }>(); if (!['pull-request','direct'].includes(body.mode)) return json({ error: "Invalid apply mode" }, 400); const client = await github(env, request); return json(await applyPlan(client, await verifyPlan(body.token, env.AGENTS_PLAN_SIGNING_KEY), body.mode)); }
      return env.ASSETS.fetch(request);
    } catch (error) { if (error instanceof Response) return error; const message = error instanceof Error ? error.message : "Unexpected error"; return json({ error: message }, /invalid|required|expired|changed|selection/i.test(message) ? 400 : 500); }
  }
} satisfies ExportedHandler<Env>;
