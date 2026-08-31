import workflows from "./generated/workflow-catalog.json";
import { createAuth, session } from "./worker/auth";
import { accounts, createAgentsRepository, github, type Account } from "./worker/github";
import {
  applyPlan,
  buildPlan,
  catalogFrom,
  isManagedPath,
  managedBundleFiles,
  repositorySnapshot,
  signPlan,
  verifyPlan,
  workflowStatuses,
  type WorkflowBundle,
} from "./worker/planner";
import { activeAccountCookie, readActiveAccount } from "./worker/scope";
import type { ManagedManifest } from "./worker/planner";

export { GitHubUserGrant } from "./worker/grant";

const publicCatalog = workflows.map(({ files: _files, ...workflow }) => workflow);
const catalog = catalogFrom(workflows as WorkflowBundle[]);

function json(value: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

function bundle(id: string): WorkflowBundle {
  const found = workflows.find((workflow) => workflow.id === id);
  if (!found) throw new Error("Invalid workflow selection");
  return found as WorkflowBundle;
}

function accountRoute(pathname: string, suffix: string) {
  const match = pathname.match(new RegExp(`^/api/accounts/([^/]+)/${suffix}$`));
  return match ? decodeURIComponent(match[1]) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function bodyRecord(request: Request) {
  const value: unknown = await request.json();
  if (!isRecord(value)) throw new Error("Invalid request body");
  return value;
}

async function authenticatedState(env: Env, request: Request) {
  const current = await session(env, request.headers);
  if (!current) throw json({ error: "Sign in required" }, 401);
  const client = await github(env, request);
  const installed = await accounts(client);
  const personal = installed.find((account) => account.type === "User")?.login ?? "";
  const activeLogin = await readActiveAccount(request.headers, installed, personal, env.AGENTS_PLAN_SIGNING_KEY);
  return {
    client,
    user: current.user,
    accounts: installed,
    activeAccount: installed.find((account) => account.login === activeLogin) ?? null,
  };
}

function allowedAccount(values: Account[], login: string) {
  const account = values.find((candidate) => candidate.login === login);
  if (!account) throw json({ error: "Account is not accessible through the GitHub App" }, 403);
  return account;
}

async function workflowCounts(client: Awaited<ReturnType<typeof github>>, account: Account) {
  if (!account.repository) return { installed: 0, outdated: 0, overridden: 0 };
  const statuses = workflowStatuses(catalog, await repositorySnapshot(client, account.login));
  return {
    installed: statuses.filter((status) => status.state === "installed").length,
    outdated: statuses.filter((status) => status.state === "outdated").length,
    overridden: statuses.filter((status) => status.state === "overridden").length,
  };
}

async function accountIndex(env: Env, request: Request) {
  const state = await authenticatedState(env, request);
  const values = await Promise.all(state.accounts.map(async (account) => ({
    ...account,
    active: account.login === state.activeAccount?.login,
    counts: await workflowCounts(state.client, account),
  })));
  return json({
    user: state.user,
    activeAccount: state.activeAccount,
    accounts: values,
    githubAppSlug: env.GITHUB_APP_SLUG,
  });
}

async function accountWorkflows(env: Env, request: Request, login: string) {
  const state = await authenticatedState(env, request);
  const account = allowedAccount(state.accounts, login);
  if (!account.repository) {
    return json({
      login,
      repository: null,
      repositoryUrl: `https://github.com/${encodeURIComponent(login)}/.agents`,
      workflows: publicCatalog.map((workflow) => ({ ...workflow, state: "add", action: "add" })),
    });
  }
  const statuses = workflowStatuses(catalog, await repositorySnapshot(state.client, login));
  return json({
    login,
    repository: account.repository,
    repositoryUrl: `https://github.com/${encodeURIComponent(login)}/.agents`,
    workflows: publicCatalog.map((workflow) => ({
      ...workflow,
      ...statuses.find((status) => status.id === workflow.id),
    })),
  });
}

export function managedResources(manifest: ManagedManifest | null) {
  const counts = new Map<string, number>();
  for (const path of Object.keys(manifest?.files ?? {})) {
    if (!isManagedPath(path)) continue;
    const [group, name] = path.split("/");
    const resource = `${group}/${name}`;
    counts.set(resource, (counts.get(resource) ?? 0) + 1);
  }
  return [...counts]
    .map(([path, files]) => ({ path, files }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function repositoryResources(env: Env, request: Request, login: string) {
  const state = await authenticatedState(env, request);
  const account = allowedAccount(state.accounts, login);
  if (!account.repository) throw json({ error: "No .agents repository exists" }, 404);
  const snapshot = await repositorySnapshot(state.client, login);
  return json({
    sha: snapshot.sha,
    resources: managedResources(snapshot.manifest),
  });
}

async function createRepository(env: Env, request: Request, login: string) {
  const state = await authenticatedState(env, request);
  const account = allowedAccount(state.accounts, login);
  if (account.repository) throw json({ error: ".agents already exists" }, 409);
  const body = await bodyRecord(request);
  if (typeof body.workflow !== "string") throw new Error("A workflow selection is required");
  const selected = bundle(body.workflow);
  return json(await createAgentsRepository(state.client, {
    account,
    private: body.private === true,
    files: await managedBundleFiles(selected),
    sourceSha: selected.sourceSha,
  }), 201);
}

async function createPlan(env: Env, request: Request, login: string) {
  const state = await authenticatedState(env, request);
  const account = allowedAccount(state.accounts, login);
  if (!account.repository) throw json({ error: "No .agents repository exists" }, 404);
  const body = await bodyRecord(request);
  const workflow = typeof body.workflow === "string" && body.workflow ? body.workflow : undefined;
  const deletes = Array.isArray(body.deletes) && body.deletes.every((value) => typeof value === "string")
    ? body.deletes
    : undefined;
  const plan = await buildPlan(state.client, {
    repository: `${login}/.agents`,
    catalog,
    workflow,
    deletes,
  });
  return json({ plan, token: await signPlan(plan, env.AGENTS_PLAN_SIGNING_KEY) });
}

async function applyAccountPlan(env: Env, request: Request, login: string) {
  const state = await authenticatedState(env, request);
  const account = allowedAccount(state.accounts, login);
  if (!account.repository) throw json({ error: "No .agents repository exists" }, 404);
  const body = await bodyRecord(request);
  if (body.mode !== "pull-request" && body.mode !== "direct") throw new Error("Invalid apply mode");
  if (typeof body.token !== "string") throw new Error("A signed plan token is required");
  const plan = await verifyPlan(body.token, env.AGENTS_PLAN_SIGNING_KEY);
  if (plan.repository !== `${login}/.agents`) throw json({ error: "Plan account does not match the route" }, 403);
  return json(await applyPlan(state.client, plan, body.mode));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/auth/")) {
        const auth = createAuth(env);
        if (request.method === "POST" && url.pathname.endsWith("/sign-out")) {
          const current = await auth.api.getSession({ headers: request.headers });
          const id = current?.user.githubUserId;
          if (typeof id === "number") await env.GITHUB_USER_GRANTS.getByName(String(id)).revoke();
        }
        return auth.handler(request);
      }

      if (url.pathname === "/api/accounts" && request.method === "GET") return accountIndex(env, request);
      if (url.pathname === "/api/accounts/active" && request.method === "PUT") {
        const state = await authenticatedState(env, request);
        const body = await bodyRecord(request);
        if (typeof body.login !== "string") throw new Error("An account login is required");
        const account = allowedAccount(state.accounts, body.login);
        return json({ activeAccount: account }, 200, {
          "set-cookie": await activeAccountCookie(account.login, env.AGENTS_PLAN_SIGNING_KEY),
        });
      }

      const workflowsLogin = accountRoute(url.pathname, "workflows");
      if (workflowsLogin && request.method === "GET") return accountWorkflows(env, request, workflowsLogin);
      const resourcesLogin = accountRoute(url.pathname, "repository/resources");
      if (resourcesLogin && request.method === "GET") return repositoryResources(env, request, resourcesLogin);
      const repositoryLogin = accountRoute(url.pathname, "repository");
      if (repositoryLogin && request.method === "POST") return createRepository(env, request, repositoryLogin);
      const plansLogin = accountRoute(url.pathname, "plans");
      if (plansLogin && request.method === "POST") return createPlan(env, request, plansLogin);
      const applyLogin = accountRoute(url.pathname, "plans/apply");
      if (applyLogin && request.method === "POST") return applyAccountPlan(env, request, applyLogin);

      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof Response) return error;
      const message = error instanceof Error ? error.message : "Unexpected error";
      const status = /invalid|required|expired|changed|selection|no workflows/i.test(message) ? 400 : 500;
      if (status === 500) {
        console.error(JSON.stringify({ message: "dashboard request failed", method: request.method, path: url.pathname, error: message }));
      }
      return json({ error: message }, status);
    }
  },
} satisfies ExportedHandler<Env>;
