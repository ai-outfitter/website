import workflows from "./generated/workflow-catalog.json";
import { dashboardRoute } from "./dashboard/routes";
import { createAuth, session } from "./worker/auth";
import { createCheckoutSession } from "./worker/billing";
import { BillingStore } from "./worker/billing-store";
import { handleStripeWebhook } from "./worker/billing-webhook";
import { accounts, canAdministerBilling, github, localGitHubToken, tokenAccounts, tokenIdentity, type Account } from "./worker/github";
import { configurationFreshness, repositoryConfiguration } from "./worker/configuration";
import {
  applyPlan,
  buildPlan,
  catalogFrom,
  signPlan,
  verifyPlan,
  type PlanRequest,
  type WorkflowBundle,
} from "./worker/management";
import { createPlayground, findPlayground } from "./worker/onboarding";
import { activeAccountCookie, readActiveAccount } from "./worker/scope";
import { handleGitHubWebhook, webhookDeps } from "./worker/webhooks";
import { installationOctokit, provisioningOctokit } from "./worker/app";
import { exportPendingMeterEvents, handleInferencePreflight, handleInferenceUsage } from "./worker/inference-billing";
import { handleProvisioningCallback, handleProvisioningClaim } from "./worker/provisioning";
import { pilotAccountAllowed, ProvisionabilityError, verifyProvisioningWorkflow } from "./worker/provisionability";

export { GitHubUserGrant } from "./worker/grant";

const catalog = catalogFrom(workflows as WorkflowBundle[]);

function json(value: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

class HttpResponseError extends Error {
  constructor(readonly response: Response) {
    super(`HTTP ${response.status}`);
  }
}

function httpError(value: unknown, status: number) {
  return new HttpResponseError(json(value, status));
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

function planRequest(body: Record<string, unknown>, account: Account): PlanRequest {
  if (body.target === "workflow") {
    if (typeof body.workflow !== "string" || !["enable", "remove"].includes(String(body.action))) throw new Error("Invalid workflow plan request");
    return {
      target: "workflow",
      workflow: body.workflow,
      action: body.action as "enable" | "remove",
      private: body.private === true,
      accountType: account.type,
    };
  }
  if (body.target === "onboarding") {
    if (typeof body.workflow !== "string") throw new Error("Invalid onboarding plan request");
    return { target: "onboarding", workflow: body.workflow, private: body.private === true, accountType: account.type };
  }
  if (body.target === "source") {
    if (typeof body.source !== "string" || (body.action !== "update" && body.action !== "remove")) throw new Error("Invalid source plan request");
    return { target: "source", source: body.source, action: body.action };
  }
  throw new Error("A plan target is required");
}

async function authenticatedState(env: Env, request: Request, options: { repositories?: boolean } = {}) {
  const local = Boolean(localGitHubToken(env, request));
  const current = local ? null : await session(env, request.headers);
  if (!local && !current) throw httpError({ error: "Sign in required" }, 401);
  const client = await github(env, request);
  const user = local ? await tokenIdentity(client) : current!.user;
  const installed = local
    ? await tokenAccounts(client, env.LOCAL_GITHUB_ACCOUNTS, options)
    : await accounts(client, options);
  const personal = installed.find((account) => account.type === "User")?.login ?? "";
  const activeLogin = await readActiveAccount(request.headers, installed, personal, env.AGENTS_PLAN_SIGNING_KEY);
  return {
    client,
    user,
    accounts: installed,
    activeAccount: installed.find((account) => account.login === activeLogin) ?? null,
  };
}

function allowedAccount(values: Account[], login: string) {
  const account = values.find((candidate) => candidate.login === login);
  if (!account) throw httpError({ error: "Account is not accessible with the authenticated GitHub credential" }, 403);
  return account;
}

async function accountIndex(env: Env, request: Request) {
  const state = await authenticatedState(env, request, { repositories: false });
  return json({
    user: state.user,
    activeAccount: state.activeAccount,
    accounts: state.accounts,
    githubAppSlug: env.GITHUB_APP_SLUG,
  });
}

async function accountConfiguration(env: Env, request: Request, login: string) {
  const state = await authenticatedState(env, request);
  const account = allowedAccount(state.accounts, login);
  return json(await repositoryConfiguration(state.client, login, account.repository, catalog));
}

async function accountSourceFreshness(env: Env, request: Request, login: string) {
  const state = await authenticatedState(env, request);
  const account = allowedAccount(state.accounts, login);
  if (!account.repository) throw httpError({ error: "No .agents repository exists" }, 404);
  const configuration = await repositoryConfiguration(state.client, login, account.repository, catalog);
  return json({ sources: await configurationFreshness(state.client, configuration.settings.sources) });
}

async function accountPlayground(env: Env, request: Request, login: string) {
  const state = await authenticatedState(env, request);
  const account = allowedAccount(state.accounts, login);
  if (request.method === "GET") {
    const playground = await findPlayground(state.client, login);
    if (!playground) throw httpError({ error: "No playground repository exists" }, 404);
    return json(playground);
  }
  return json(await createPlayground(state.client, login, account.type));
}

async function createPlan(env: Env, request: Request, login: string) {
  const state = await authenticatedState(env, request);
  const account = allowedAccount(state.accounts, login);
  const body = await bodyRecord(request);
  const plan = await buildPlan(state.client, {
    repository: `${login}/.agents`,
    catalog,
    request: planRequest(body, account),
    repositoryExists: Boolean(account.repository),
  });
  return json({ plan, token: await signPlan(plan, env.AGENTS_PLAN_SIGNING_KEY) });
}

async function applyAccountPlan(env: Env, request: Request, login: string) {
  const state = await authenticatedState(env, request);
  const account = allowedAccount(state.accounts, login);
  const body = await bodyRecord(request);
  if (body.mode !== "pull-request" && body.mode !== "direct") throw new Error("Invalid apply mode");
  if (typeof body.token !== "string") throw new Error("A signed plan token is required");
  const plan = await verifyPlan(body.token, env.AGENTS_PLAN_SIGNING_KEY);
  if (plan.repository !== `${login}/.agents`) throw httpError({ error: "Plan account does not match the route" }, 403);
  if (Boolean(account.repository) !== (plan.baseSha !== null)) throw httpError({ error: "Repository state changed after preview; create a new plan" }, 409);
  return json(await applyPlan(state.client, plan, body.mode));
}

async function residentCheckout(env: Env, request: Request) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { allow: "POST" });
  const state = await authenticatedState(env, request);
  const account = state.activeAccount;
  if (!account) throw httpError({ error: "Select a GitHub account before checkout" }, 400);
  if (account.type !== "Organization") throw httpError({ error: "Resident subscriptions require a GitHub organization" }, 400);
  if (!pilotAccountAllowed(account.id, env.RESIDENT_PILOT_GITHUB_ACCOUNT_IDS)) {
    throw httpError({ error: "Resident checkout is currently limited to approved pilot organizations" }, 403);
  }
  if (!account.installationId) throw httpError({ error: "Install the GitHub App for this account before checkout" }, 400);
  if (!account.repository) throw httpError({ error: "Create the organization's .agents repository before checkout" }, 409);
  const viewer = await tokenIdentity(state.client);
  if (!await canAdministerBilling(state.client, account, viewer.id)) {
    throw httpError({ error: "Organization administrator access is required for billing" }, 403);
  }
  const workflow = env.PROVISIONING_WORKFLOW?.trim();
  if (!workflow) throw httpError({ error: "Resident provisioning is not configured" }, 503);
  try {
    await verifyProvisioningWorkflow(provisioningOctokit(env, account.installationId), account.login, workflow);
  } catch (error) {
    if (error instanceof ProvisionabilityError) throw httpError({ error: error.message }, 409);
    const status = Number((error as { status?: number }).status);
    if (status === 403) throw httpError({ error: "The GitHub App needs Actions write and Contents read access before checkout" }, 409);
    if (status === 404) throw httpError({ error: "The configured provisioning workflow is not available on main" }, 409);
    console.error(JSON.stringify({ message: "Provisioning workflow verification failed", status: Number.isFinite(status) ? status : null }));
    throw httpError({ error: "GitHub could not verify resident provisioning" }, 502);
  }
  return createCheckoutSession(request, env, {
    identity: {
      githubAccountId: account.id,
      githubAccountLogin: account.login,
      githubAccountType: account.type,
      githubInstallationId: account.installationId,
      githubUserId: viewer.id,
      githubUserLogin: viewer.login,
    },
    store: new BillingStore(env.BILLING_DB),
  });
}

async function checkoutStatus(env: Env, request: Request) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { allow: "GET" });
  const sessionId = new URL(request.url).searchParams.get("session_id")?.trim();
  if (!sessionId?.startsWith("cs_") || sessionId.length > 255) throw httpError({ error: "A valid Checkout Session is required" }, 400);
  const state = await authenticatedState(env, request, { repositories: false });
  const viewer = await tokenIdentity(state.client);
  const status = await new BillingStore(env.BILLING_DB).getCheckoutStatusBySessionId(sessionId, String(viewer.id));
  if (!status) throw httpError({ error: "Checkout Session was not found" }, 404);
  return json({
    checkout: status.checkoutLease.status,
    subscription: status.subscription?.status ?? null,
    entitlement: status.entitlement?.status ?? null,
    resident: status.resident ? {
      name: status.resident.agentResourceName,
      desiredState: status.resident.desiredState,
      observedState: status.resident.observedState,
    } : null,
  });
}

function paidResidentResolver(env: Env) {
  const store = new BillingStore(env.BILLING_DB);
  return async (githubAccountId: number, installationId: number) => {
    const account = await store.getBillingAccountByGitHubAccountId(String(githubAccountId));
    if (!account || account.githubInstallationId !== String(installationId)) return null;
    const status = await store.getAccountStatus(account.id);
    if (!status?.resident?.personaLogin) return null;
    return await store.hasActiveResidentEntitlement(account.id, status.resident.id, "wake")
      ? status.resident.personaLogin : null;
  };
}

export default {
  async fetch(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
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

      if (url.pathname === "/api/webhooks/github" && request.method === "POST") {
        return await handleGitHubWebhook(request, webhookDeps(env, paidResidentResolver(env)));
      }
      if (url.pathname === "/api/webhooks/stripe") {
        return await handleStripeWebhook(request, env, {
          store: new BillingStore(env.BILLING_DB),
          dispatchProvisioning: async (account) => {
            const workflow = env.PROVISIONING_WORKFLOW?.trim();
            if (!workflow) throw new Error("Provisioning workflow is not configured");
            await installationOctokit(env, Number(account.githubInstallationId)).request(
              "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
              { owner: account.githubAccountLogin, repo: ".agents", workflow_id: workflow, ref: "main" },
            );
          },
        });
      }
      if (url.pathname === "/api/billing/checkout") return await residentCheckout(env, request);
      if (url.pathname === "/api/billing/status") return await checkoutStatus(env, request);
      if (url.pathname === "/api/internal/billing/inference/preflight") return await handleInferencePreflight(request, env);
      if (url.pathname === "/api/internal/billing/inference/usage") {
        const response = await handleInferenceUsage(request, env);
        if (response.ok) context?.waitUntil(exportPendingMeterEvents(env).catch((error) => {
          console.error(JSON.stringify({ message: "Stripe meter export failed", error: error instanceof Error ? error.message : "Unexpected error" }));
        }));
        return response;
      }
      if (url.pathname === "/api/internal/provisioning/claim") return await handleProvisioningClaim(request, env);
      if (url.pathname === "/api/internal/provisioning/callback") return await handleProvisioningCallback(request, env);
      if (url.pathname === "/api/accounts" && request.method === "GET") return await accountIndex(env, request);
      if (url.pathname === "/api/accounts/active" && request.method === "PUT") {
        const state = await authenticatedState(env, request);
        const body = await bodyRecord(request);
        if (typeof body.login !== "string") throw new Error("An account login is required");
        const account = allowedAccount(state.accounts, body.login);
        return json({ activeAccount: account }, 200, {
          "set-cookie": await activeAccountCookie(account.login, env.AGENTS_PLAN_SIGNING_KEY),
        });
      }

      const configurationLogin = accountRoute(url.pathname, "configuration");
      if (configurationLogin && request.method === "GET") return await accountConfiguration(env, request, configurationLogin);
      const freshnessLogin = accountRoute(url.pathname, "configuration/freshness");
      if (freshnessLogin && request.method === "GET") return await accountSourceFreshness(env, request, freshnessLogin);
      const plansLogin = accountRoute(url.pathname, "plans");
      if (plansLogin && request.method === "POST") return await createPlan(env, request, plansLogin);
      const playgroundLogin = accountRoute(url.pathname, "playground");
      if (playgroundLogin && (request.method === "GET" || request.method === "POST")) return await accountPlayground(env, request, playgroundLogin);
      const applyLogin = accountRoute(url.pathname, "plans/apply");
      if (applyLogin && request.method === "POST") return await applyAccountPlan(env, request, applyLogin);

      if ((request.method === "GET" || request.method === "HEAD") && dashboardRoute(url.pathname)) {
        const dashboard = new URL("/dashboard/", url);
        return env.ASSETS.fetch(new Request(dashboard, request));
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof HttpResponseError) return error.response;
      const message = error instanceof Error ? error.message : "Unexpected error";
      const status = /invalid|required|expired|changed|selection|no workflows/i.test(message) ? 400 : 500;
      if (status === 500) {
        console.error(JSON.stringify({ message: "dashboard request failed", method: request.method, path: url.pathname, error: message }));
      }
      return json({ error: message }, status);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const result = await exportPendingMeterEvents(env);
    console.log(JSON.stringify({ message: "Stripe meter export completed", ...result }));
  },
} satisfies ExportedHandler<Env>;
