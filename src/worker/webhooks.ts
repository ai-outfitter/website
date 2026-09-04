// GitHub webhook endpoint for the hosted software factory. A person routes an
// issue to us by label or mention; we mint a token scoped to that repository
// and dispatch our private runner. The customer repository needs nothing.

import type { Octokit } from "@octokit/core";
import { installationOctokit, scopedInstallationToken, appConfigured, verifySignature } from "./app";
import { RUNNER, agentBranch, runnerInputs, startsRun, subjectFromWebhook, triggerFromWebhook, type IssueSubject } from "./factory";

export type WebhookDeps = {
  verify(body: string, signature: string | null): Promise<boolean>;
  installationClient(installationId: number): Pick<Octokit, "request">;
  scopedToken(installationId: number, repositoryName: string): Promise<string>;
  runnerClient(): Pick<Octokit, "request">;
  botLogin: string;
  triggerLabel?: string;
  assignee?: string;
};

/** Production wiring; null when the App's server credentials are absent. */
export function webhookDeps(env: Env): WebhookDeps | null {
  if (!appConfigured(env)) return null;
  const runnerInstallation = Number(env.RUNNER_INSTALLATION_ID ?? "155042682");
  return {
    verify: (body, signature) => verifySignature(env.GITHUB_APP_WEBHOOK_SECRET, body, signature),
    installationClient: (installationId) => installationOctokit(env, installationId),
    scopedToken: (installationId, repositoryName) => scopedInstallationToken(env, installationId, repositoryName),
    runnerClient: () => installationOctokit(env, runnerInstallation),
    botLogin: `${env.GITHUB_APP_SLUG}[bot]`,
    triggerLabel: env.TRIGGER_LABEL,
    assignee: env.TRIGGER_ASSIGNEE,
  };
}

function log(message: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ message, ...fields }));
}

function result(status: number, outcome: string, fields: Record<string, unknown> = {}) {
  return Response.json({ outcome, ...fields }, { status, headers: { "cache-control": "no-store" } });
}

async function openAgentPullRequest(client: Pick<Octokit, "request">, subject: IssueSubject) {
  const { data } = await client.request("GET /repos/{owner}/{repo}/pulls", {
    owner: subject.repository.owner.login,
    repo: subject.repository.name,
    head: `${subject.repository.owner.login}:${agentBranch(subject.issue.number)}`,
    state: "open",
  });
  return (data as Array<{ number: number }>)[0]?.number;
}

async function comment(client: Pick<Octokit, "request">, subject: IssueSubject, body: string) {
  await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    owner: subject.repository.owner.login,
    repo: subject.repository.name,
    issue_number: subject.issue.number,
    body,
  });
}

export async function handleGitHubWebhook(request: Request, deps: WebhookDeps | null): Promise<Response> {
  if (!deps) return result(503, "not-configured");
  const body = await request.text();
  if (!(await deps.verify(body, request.headers.get("x-hub-signature-256")))) return result(401, "bad-signature");
  const event = request.headers.get("x-github-event") ?? "";
  const delivery = request.headers.get("x-github-delivery") ?? "";
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return result(400, "bad-json");
  }
  if (event === "ping") return result(200, "pong");
  const trigger = triggerFromWebhook(event, payload);
  if (!trigger) return result(200, "ignored");
  if (!startsRun(trigger, deps)) return result(200, "ignored");
  const subject = subjectFromWebhook(payload);
  if (!subject) return result(200, "ignored");
  const repository = subject.repository.full_name;
  const issue = subject.issue.number;
  const client = deps.installationClient(subject.installationId);
  const existing = await openAgentPullRequest(client, subject);
  if (existing) {
    log("trigger_deduped", { delivery, repository, issue, pullRequest: existing });
    return result(200, "open-agent-pull-request", { pullRequest: existing });
  }
  try {
    const token = await deps.scopedToken(subject.installationId, subject.repository.name);
    await deps.runnerClient().request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
      owner: RUNNER.owner,
      repo: RUNNER.repo,
      workflow_id: RUNNER.workflow,
      ref: RUNNER.ref,
      inputs: runnerInputs({ repository, issue, token }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("dispatch_failed", { delivery, repository, issue, error: message });
    await comment(client, subject, "I could not start a hosted run for this issue; the AI Outfitter team has the error in the app logs.").catch(() => undefined);
    return result(202, "dispatch-failed");
  }
  log("run_dispatched", { delivery, repository, issue, trigger: trigger.kind });
  return result(202, "dispatched", { repository, issue });
}
