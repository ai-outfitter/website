import { describe, expect, it, vi } from "vitest";
import { handleGitHubWebhook, type WebhookDeps } from "./webhooks";

type Call = { route: string; params: Record<string, unknown> };

function deps(overrides: Partial<WebhookDeps> & {
  comments?: Array<{ body: string; user: { login: string } }>;
  commentPages?: Record<number, Array<{ body: string; user: { login: string } }>>;
  labels?: Array<{ name: string }>;
  pulls?: Array<{ number: number }>;
  dispatchError?: Error;
} = {}) {
  const calls: Call[] = [];
  const request = async (route: string, params: Record<string, unknown>) => {
    calls.push({ route, params });
    if (route.startsWith("GET /repos/{owner}/{repo}/pulls")) return { data: overrides.pulls ?? [] };
    if (route.startsWith("GET /repos/{owner}/{repo}/issues/{issue_number}/comments")) {
      return { data: overrides.commentPages?.[Number(params.page ?? 1)] ?? overrides.comments ?? [] };
    }
    if (route.startsWith("GET /repos/{owner}/{repo}/labels")) {
      return { data: overrides.labels ?? [{ name: "bug" }, { name: "enhancement" }] };
    }
    if (route.includes("dispatches") && overrides.dispatchError) throw overrides.dispatchError;
    return { data: {} };
  };
  const value: WebhookDeps = {
    verify: async () => true,
    installationClient: () => ({ request } as never),
    scopedToken: async () => "scoped-token",
    runnerClient: () => ({ request } as never),
    botLogin: "ai-outfitter[bot]",
    targetOwner: "ai-outfitter",
    triagerLogin: "luce-unsup",
    autoStartActorIds: new Set([8276365]),
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

const opened = {
  action: "opened",
  installation: { id: 42 },
  repository: { full_name: "ai-outfitter/app", name: "app", owner: { login: "ai-outfitter" } },
  issue: { number: 9, user: { id: 8276365, type: "User" } },
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
    expect((await handleGitHubWebhook(delivery("issues", { ...opened, issue: { ...opened.issue, user: { id: 7, type: "User" } } }), d)).status).toBe(200);
    expect((await handleGitHubWebhook(delivery("issues", { ...labeled, label: { name: "bug" } }), d)).status).toBe(200);
    expect((await handleGitHubWebhook(delivery("issues", { ...labeled, issue: { number: 9, pull_request: {} } }), d)).status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("asks the resident Luce to triage an allowlisted AI Outfitter issue", async () => {
    const scopedToken = vi.fn(async () => "unused");
    const { deps: d, calls } = deps({ scopedToken });
    const response = await handleGitHubWebhook(delivery("issues", opened), d);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ outcome: "resident-triage-requested", repository: "ai-outfitter/app", issue: 9, triager: "luce-unsup" });
    expect(scopedToken).not.toHaveBeenCalled();
    expect(calls.some((call) => call.route.includes("dispatches"))).toBe(false);
    const note = calls.find((call) => call.route.startsWith("POST ") && call.route.includes("comments"));
    expect(note?.params.body).toContain("@luce-unsup");
    expect(note?.params.body).toContain("Luce or Vega");
    expect(note?.params.body).toContain('["bug","enhancement"]');
    expect(note?.params.body).not.toContain("type:*");
  });

  it("does not post a second resident wake when GitHub redelivers an opened issue", async () => {
    const { deps: d, calls } = deps({
      comments: [{ body: "<!-- ai-outfitter:resident-triage -->\n@luce-unsup triage this issue", user: { login: "ai-outfitter[bot]" } }],
    });
    const response = await handleGitHubWebhook(delivery("issues", opened), d);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "resident-triage-already-requested", issue: 9 });
    expect(calls.filter((call) => call.route.startsWith("POST "))).toHaveLength(0);
  });

  it("finds an earlier resident wake beyond the first comment page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ body: `comment ${index}`, user: { login: "someone" } }));
    const { deps: d, calls } = deps({
      commentPages: {
        1: firstPage,
        2: [{ body: "<!-- ai-outfitter:resident-triage -->", user: { login: "ai-outfitter[bot]" } }],
      },
    });
    const response = await handleGitHubWebhook(delivery("issues", opened), d);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "resident-triage-already-requested", issue: 9 });
    expect(calls.filter((call) => call.route.startsWith("GET ") && call.route.includes("comments"))).toHaveLength(2);
    expect(calls.filter((call) => call.route.startsWith("POST "))).toHaveLength(0);
  });

  it("asks for human input when the repository has no classification labels", async () => {
    const { deps: d, calls } = deps({ labels: [] });
    const response = await handleGitHubWebhook(delivery("issues", opened), d);
    expect(response.status).toBe(202);
    const note = calls.find((call) => call.route.startsWith("POST ") && call.route.includes("comments"));
    expect(note?.params.body).toContain("Do not assign the issue");
    expect(note?.params.body).toContain("ask a human maintainer");
  });

  it("does not auto-triage an issue outside the AI Outfitter organization", async () => {
    const { deps: d, calls } = deps();
    const payload = { ...opened, repository: { full_name: "acme/app", name: "app", owner: { login: "acme" } } };
    expect((await handleGitHubWebhook(delivery("issues", payload), d)).status).toBe(200);
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
