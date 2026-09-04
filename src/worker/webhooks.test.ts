import { describe, expect, it, vi } from "vitest";
import { handleGitHubWebhook, type WebhookDeps } from "./webhooks";

type Call = { route: string; params: Record<string, unknown> };

function deps(overrides: Partial<WebhookDeps> & { pulls?: Array<{ number: number }>; dispatchError?: Error } = {}) {
  const calls: Call[] = [];
  const request = async (route: string, params: Record<string, unknown>) => {
    calls.push({ route, params });
    if (route.startsWith("GET /repos/{owner}/{repo}/pulls")) return { data: overrides.pulls ?? [] };
    if (route.includes("dispatches") && overrides.dispatchError) throw overrides.dispatchError;
    return { data: {} };
  };
  const value: WebhookDeps = {
    verify: async () => true,
    installationClient: () => ({ request } as never),
    scopedToken: async () => "scoped-token",
    runnerClient: () => ({ request } as never),
    botLogin: "ai-outfitter[bot]",
    ...overrides,
  };
  return { deps: value, calls };
}

const labeled = {
  action: "labeled",
  label: { name: "ai-outfitter" },
  installation: { id: 42 },
  repository: { full_name: "acme/app", name: "app", owner: { login: "acme" } },
  issue: { number: 9 },
};

function delivery(event: string, payload: unknown, signature = "sha256=ok") {
  return new Request("https://ai-outfitter.com/api/webhooks/github", {
    method: "POST",
    headers: { "x-github-event": event, "x-github-delivery": "d1", "x-hub-signature-256": signature, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("handleGitHubWebhook", () => {
  it("answers 503 until the App's server credentials exist", async () => {
    expect((await handleGitHubWebhook(delivery("issues", labeled), null)).status).toBe(503);
  });

  it("rejects a bad signature before reading the event", async () => {
    const { deps: d, calls } = deps({ verify: async () => false });
    expect((await handleGitHubWebhook(delivery("issues", labeled), d)).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("answers a ping and ignores events that start nothing", async () => {
    const { deps: d, calls } = deps();
    expect((await handleGitHubWebhook(delivery("ping", { zen: "hi" }), d)).status).toBe(200);
    expect((await handleGitHubWebhook(delivery("issues", { ...labeled, action: "opened" }), d)).status).toBe(200);
    expect((await handleGitHubWebhook(delivery("issues", { ...labeled, label: { name: "bug" } }), d)).status).toBe(200);
    expect((await handleGitHubWebhook(delivery("issues", { ...labeled, issue: { number: 9, pull_request: {} } }), d)).status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("dispatches the runner with a token scoped to the one repository", async () => {
    const scopedToken = vi.fn(async () => "scoped-token");
    const { deps: d, calls } = deps({ scopedToken });
    const response = await handleGitHubWebhook(delivery("issues", labeled), d);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ outcome: "dispatched", repository: "acme/app", issue: 9 });
    expect(scopedToken).toHaveBeenCalledWith(42, "app");
    const dispatch = calls.find((call) => call.route.includes("dispatches"));
    expect(dispatch?.params).toEqual({
      owner: "ai-outfitter",
      repo: "factory-runner",
      workflow_id: "outfitter-agent.yml",
      ref: "main",
      inputs: { repository: "acme/app", issue_number: "9", pr_number: "", token: "scoped-token" },
    });
  });

  it("starts nothing while an agent pull request for the issue is open", async () => {
    const { deps: d, calls } = deps({ pulls: [{ number: 15 }] });
    const response = await handleGitHubWebhook(delivery("issues", labeled), d);
    expect(response.status).toBe(200);
    expect(calls.some((call) => call.route.includes("dispatches"))).toBe(false);
  });

  it("tells the issue when the dispatch fails and does not ask GitHub to retry", async () => {
    const { deps: d, calls } = deps({ dispatchError: new Error("Actions disabled") });
    const response = await handleGitHubWebhook(delivery("issues", labeled), d);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ outcome: "dispatch-failed" });
    const note = calls.find((call) => call.route.includes("comments"));
    expect(note?.params.issue_number).toBe(9);
  });

  it("accepts a mention from a member on an issue", async () => {
    const { deps: d, calls } = deps();
    const payload = { ...labeled, action: "created", label: undefined, comment: { body: "@ai-outfitter please", author_association: "MEMBER", user: { type: "User" } } };
    expect((await handleGitHubWebhook(delivery("issue_comment", payload), d)).status).toBe(202);
    expect(calls.some((call) => call.route.includes("dispatches"))).toBe(true);
  });
});
