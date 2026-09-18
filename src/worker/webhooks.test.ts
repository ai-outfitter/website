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
    resolveResident: async () => "luce-unsup",
    botLogin: "ai-outfitter[bot]",
    autoStartActorIds: new Set([8276365]),
    ...overrides,
  };
  return { deps: value, calls };
}

const labeled = {
  action: "labeled",
  label: { name: "ai-outfitter" },
  installation: { id: 42 },
  repository: { full_name: "acme/app", name: "app", owner: { id: 101, login: "acme" } },
  issue: { number: 9 },
};

const opened = {
  action: "opened",
  installation: { id: 42 },
  repository: { full_name: "ai-outfitter/app", name: "app", owner: { id: 101, login: "ai-outfitter" } },
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
    expect((await handleGitHubWebhook(delivery("issues", { ...opened, issue: { ...opened.issue, user: { id: 7, type: "Bot" } } }), d)).status).toBe(200);
    expect((await handleGitHubWebhook(delivery("issues", { ...labeled, label: { name: "bug" } }), d)).status).toBe(200);
    expect((await handleGitHubWebhook(delivery("issues", { ...labeled, issue: { number: 9, pull_request: {} } }), d)).status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("asks the resident Luce to triage using repository-defined classification labels", async () => {
    const scopedToken = vi.fn(async () => "unused");
    const resolveResident = vi.fn(async () => "luce-unsup");
    const { deps: d, calls } = deps({
      scopedToken,
      resolveResident,
      labels: [
        { name: "research" },
        { name: "feature" },
        { name: "idea" },
        { name: "type:maintenance" },
        { name: "software-factory" },
        { name: "autorelease: pending" },
        { name: "autorelease: tagged" },
        { name: "status:blocked" },
        { name: "good first issue" },
      ],
    });
    const response = await handleGitHubWebhook(delivery("issues", opened), d);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ outcome: "resident-triage-requested", repository: "ai-outfitter/app", issue: 9, triager: "luce-unsup" });
    expect(resolveResident).toHaveBeenCalledWith(101, 42);
    expect(scopedToken).not.toHaveBeenCalled();
    expect(calls.some((call) => call.route.includes("dispatches"))).toBe(false);
    const note = calls.find((call) => call.route.startsWith("POST ") && call.route.includes("comments"));
    expect(note?.params.body).toContain("@luce-unsup");
    expect(note?.params.body).toContain("Luce or Vega");
    expect(note?.params.body).toContain('["research","feature","idea","type:maintenance"]');
    expect(note?.params.body).not.toContain("software-factory");
    expect(note?.params.body).not.toContain("autorelease: pending");
    expect(note?.params.body).not.toContain("autorelease: tagged");
    expect(note?.params.body).not.toContain("status:blocked");
    expect(note?.params.body).not.toContain("good first issue");
    expect(note?.params.body).not.toContain("type:*");
  });

  it("asks an entitled resident to triage regardless of the issue author's global allowlist membership", async () => {
    const resolveResident = vi.fn(async () => "luce-unsup");
    const { deps: d, calls } = deps({ resolveResident, autoStartActorIds: new Set([8276365]) });
    const payload = { ...opened, issue: { ...opened.issue, user: { id: 7, type: "User" } } };
    const response = await handleGitHubWebhook(delivery("issues", payload), d);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ outcome: "resident-triage-requested", triager: "luce-unsup" });
    expect(resolveResident).toHaveBeenCalledWith(101, 42);
    expect(calls.some((call) => call.route.startsWith("POST ") && call.route.includes("comments"))).toBe(true);
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

  it("asks for human input when the repository has only routing and metadata labels", async () => {
    const { deps: d, calls } = deps({
      labels: [{ name: "software-factory" }, { name: "autorelease: pending" }, { name: "autorelease: tagged" }, { name: "status:blocked" }, { name: "needs-human" }],
    });
    const response = await handleGitHubWebhook(delivery("issues", opened), d);
    expect(response.status).toBe(202);
    const note = calls.find((call) => call.route.startsWith("POST ") && call.route.includes("comments"));
    expect(note?.params.body).toContain("Do not assign the issue");
    expect(note?.params.body).toContain("ask a human maintainer");
  });

  it.each(["unpaid", "suspended", "resident-not-ready"])("does not auto-triage when billing resolves %s as ineligible", async () => {
    const resolveResident = vi.fn(async () => null);
    const { deps: d, calls } = deps({ resolveResident });
    const response = await handleGitHubWebhook(delivery("issues", opened), d);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "ignored" });
    expect(resolveResident).toHaveBeenCalledWith(101, 42);
    expect(calls).toHaveLength(0);
  });

  it("uses immutable owner identity rather than the mutable owner login", async () => {
    const resolveResident = vi.fn(async (ownerAccountId: number, installationId: number) =>
      ownerAccountId === 101 && installationId === 42 ? "vega-unsup" : null,
    );
    const { deps: d, calls } = deps({ resolveResident });
    const payload = {
      ...opened,
      repository: { ...opened.repository, full_name: "renamed-owner/app", owner: { id: 101, login: "renamed-owner" } },
    };
    const response = await handleGitHubWebhook(delivery("issues", payload), d);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ outcome: "resident-triage-requested", triager: "vega-unsup" });
    expect(calls.find((call) => call.route.startsWith("POST ") && call.route.includes("comments"))?.params.body).toContain("@vega-unsup");
  });

  it("fails closed for missing IDs, mismatched installations, and missing personas", async () => {
    const cases: Array<{ name: string; payload: unknown; resolveResident: WebhookDeps["resolveResident"] }> = [
      {
        name: "missing owner account ID",
        payload: { ...opened, repository: { ...opened.repository, owner: { login: "ai-outfitter" } } },
        resolveResident: vi.fn(async () => "luce-unsup"),
      },
      {
        name: "mismatched installation",
        payload: { ...opened, installation: { id: 99 } },
        resolveResident: vi.fn(async (_ownerAccountId, installationId) => installationId === 42 ? "luce-unsup" : null),
      },
      { name: "missing persona", payload: opened, resolveResident: vi.fn(async () => "  ") },
      { name: "unsafe persona", payload: opened, resolveResident: vi.fn(async () => "luce\n@attacker") },
    ];
    for (const scenario of cases) {
      const { deps: d, calls } = deps({ resolveResident: scenario.resolveResident });
      const response = await handleGitHubWebhook(delivery("issues", scenario.payload), d);
      expect(response.status, scenario.name).toBe(200);
      expect(await response.json(), scenario.name).toEqual({ outcome: "ignored" });
      expect(calls, scenario.name).toHaveLength(0);
    }
    expect(cases[0].resolveResident).not.toHaveBeenCalled();
  });

  it("returns a retryable response when entitlement resolution fails transiently", async () => {
    const resolveResident = vi.fn(async () => { throw new Error("billing record secret"); });
    const { deps: d, calls } = deps({ resolveResident });
    const response = await handleGitHubWebhook(delivery("issues", opened), d);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ outcome: "resident-resolution-failed" });
    expect(calls).toHaveLength(0);
  });

  it("dispatches the runner with a token scoped to the one repository", async () => {
    const scopedToken = vi.fn(async () => "scoped-token");
    const resolveResident = vi.fn(async () => { throw new Error("must not be called"); });
    const { deps: d, calls } = deps({ scopedToken, resolveResident });
    const response = await handleGitHubWebhook(delivery("issues", labeled), d);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ outcome: "dispatched", repository: "acme/app", issue: 9 });
    expect(scopedToken).toHaveBeenCalledWith(42, "app");
    expect(resolveResident).not.toHaveBeenCalled();
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
