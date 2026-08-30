import workflows from "./generated/workflow-catalog.json";
import { createAuth, session } from "./worker/auth";
import { github, repositories, tree } from "./worker/github";
import { agentsPage } from "./worker/page";
import { applyPlan, buildPlan, signPlan, verifyPlan } from "./worker/planner";
export { GitHubUserGrant } from "./worker/grant";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
async function catalog(client: Awaited<ReturnType<typeof github>>, env: Env) {
  const [owner, repo] = env.COMMUNITY_REPOSITORY.split("/"); const source = await tree(client, owner, repo, env.COMMUNITY_REF);
  const paths = new Set(source.entries.map((entry) => entry.path));
  const agents = [...new Set(source.entries.filter((entry) => /^agents\/[^/]+\/agent\.md$/.test(entry.path)).map((entry) => entry.path.split("/").slice(0, 2).join("/")))];
  const profiles = agents.map((resource) => ({ id: resource, title: resource.split("/")[1], description: "Community agent profile", resources: [resource], available: true, missing: [] }));
  return [...profiles, ...workflows.map((item) => { const missing = item.resources.filter((resource) => ![...paths].some((path) => path === resource || path.startsWith(`${resource}/`))); return { ...item, available: missing.length === 0, missing }; })];
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
      if (url.pathname === "/agents" || url.pathname === "/agents/") return agentsPage();
      if (url.pathname === "/api/agents/bootstrap") {
        const current = await session(env, request.headers); if (!current) return json({ user: null, repositories: [], catalog: [] });
        const client = await github(env, request); return json({ user: current.user, repositories: await repositories(client), catalog: await catalog(client, env) });
      }
      if (url.pathname.match(/^\/api\/agents\/repositories\/[^/]+\/[^/]+$/) && request.method === "GET") {
        const [, , , , owner, repo] = url.pathname.split("/"); const client = await github(env, request); const listing = await tree(client, owner, repo, "HEAD");
        const prefix = repo === ".agents" ? "" : ".agents/"; const counts = new Map<string, number>();
        for (const entry of listing.entries) { if (entry.type !== "blob" || !entry.path.startsWith(prefix)) continue; const parts = entry.path.slice(prefix.length).split("/"); if (!['agents','skills','prompts'].includes(parts[0]) || !parts[1]) continue; const resource = `${prefix}${parts[0]}/${parts[1]}`; counts.set(resource, (counts.get(resource) ?? 0) + 1); }
        return json({ sha: listing.sha, resources: [...counts].map(([path, files]) => ({ path, files })).sort((a, b) => a.path.localeCompare(b.path)) });
      }
      if (url.pathname === "/api/agents/plans" && request.method === "POST") { const client = await github(env, request); const plan = await buildPlan(client, env, await request.json()); return json({ plan, token: await signPlan(plan, env.AGENTS_PLAN_SIGNING_KEY) }); }
      if (url.pathname === "/api/agents/apply" && request.method === "POST") { const body = await request.json<{ token: string; mode: "pull-request" | "direct" }>(); if (!['pull-request','direct'].includes(body.mode)) return json({ error: "Invalid apply mode" }, 400); const client = await github(env, request); return json(await applyPlan(client, await verifyPlan(body.token, env.AGENTS_PLAN_SIGNING_KEY), body.mode)); }
      return env.ASSETS.fetch(request);
    } catch (error) { if (error instanceof Response) return error; const message = error instanceof Error ? error.message : "Unexpected error"; return json({ error: message }, /invalid|required|expired|changed|selection/i.test(message) ? 400 : 500); }
  }
} satisfies ExportedHandler<Env>;
