import { describe, expect, it, vi } from "vitest";
import { createPlayground, findPlayground, localEngineeringFiles, playgroundIssueBody } from "./onboarding";

type Call = { route: string; params: Record<string, unknown> };
function client(handlers: Record<string, (params: Record<string, unknown>, calls: Call[]) => unknown>) {
  const calls: Call[] = [];
  const request = vi.fn(async (route: string, params: Record<string, unknown> = {}) => {
    calls.push({ route, params });
    const handler = handlers[route];
    if (!handler) throw new Error(`Unhandled ${route}`);
    const value = handler(params, calls);
    if (value instanceof Error) throw value;
    return { data: value };
  });
  return { client: { request } as never, calls };
}
const missing = () => Object.assign(new Error("Not Found"), { status: 404 });

describe("playground", () => {
  it("forks the upstream once, enables issues and actions, then files the issue", async () => {
    let repositoryRequests = 0;
    const { client: octokit, calls } = client({
      "GET /repos/{owner}/{repo}": (params) => {
        if (params.repo !== "outfitter-playground") return missing();
        repositoryRequests += 1;
        return repositoryRequests === 1 ? missing() : { full_name: "acme/outfitter-playground", html_url: "https://github.com/acme/outfitter-playground", default_branch: "main", has_issues: false };
      },
      "POST /repos/{owner}/{repo}/forks": () => ({}),
      "GET /repos/{owner}/{repo}/commits/{ref}": () => ({ sha: "head" }),
      "PATCH /repos/{owner}/{repo}": () => ({}),
      "PUT /repos/{owner}/{repo}/actions/permissions": () => ({}),
      "GET /repos/{owner}/{repo}/issues": () => [],
      "POST /repos/{owner}/{repo}/issues": () => ({ number: 1, html_url: "https://github.com/acme/outfitter-playground/issues/1" }),
    });
    const result = await createPlayground(octokit, "acme", "Organization");
    expect(result.repository).toEqual({ fullName: "acme/outfitter-playground", url: "https://github.com/acme/outfitter-playground", defaultBranch: "main", created: true });
    expect(result.issue).toMatchObject({ number: 1, created: true });
    const fork = calls.find((call) => call.route === "POST /repos/{owner}/{repo}/forks")!;
    expect(fork.params).toEqual({ owner: "ai-outfitter", repo: "bash-saver", name: "outfitter-playground", default_branch_only: true, organization: "acme" });
    expect(calls.find((call) => call.route === "PATCH /repos/{owner}/{repo}")?.params).toMatchObject({ has_issues: true });
    expect(calls.find((call) => call.route === "PUT /repos/{owner}/{repo}/actions/permissions")?.params).toMatchObject({ enabled: true });
    expect(calls.find((call) => call.route === "POST /repos/{owner}/{repo}/issues")?.params).toMatchObject({ owner: "acme", repo: "outfitter-playground", body: playgroundIssueBody("acme") });
  });

  it("reuses an existing fork and issue without forking again", async () => {
    const { client: octokit, calls } = client({
      "GET /repos/{owner}/{repo}": () => ({ full_name: "octo/outfitter-playground", html_url: "https://github.com/octo/outfitter-playground", default_branch: "main", has_issues: true }),
      "GET /repos/{owner}/{repo}/issues": () => [{ number: 4, title: "Add a describeConfig helper that summarizes the effective configuration", html_url: "https://github.com/octo/outfitter-playground/issues/4" }],
    });
    const result = await createPlayground(octokit, "octo", "User");
    expect(result.repository.created).toBe(false);
    expect(result.issue).toEqual({ number: 4, url: "https://github.com/octo/outfitter-playground/issues/4", title: "Add a describeConfig helper that summarizes the effective configuration", created: false });
    expect(calls.map((call) => call.route)).toEqual(["GET /repos/{owner}/{repo}", "GET /repos/{owner}/{repo}/issues"]);
    expect(await findPlayground(octokit, "octo")).toMatchObject({ repository: { created: false }, issue: { number: 4 } });
  });

  it("reports no playground for an account without the fork", async () => {
    const { client: octokit } = client({ "GET /repos/{owner}/{repo}": () => missing() });
    expect(await findPlayground(octokit, "acme")).toBeNull();
  });
});

describe("local engineering composition", () => {
  it("delegates implementation and review to distinct agents with a formal review grant", () => {
    const files = Object.fromEntries(localEngineeringFiles("acme").map((file) => [file.path, file.after!]));
    expect(files["agents/local-engineer/agent.md"]).toContain("subagents: [implementer, reviewer]");
    expect(files["agents/local-engineer/agent.md"]).toContain("gh pr ready");
    expect(files["agents/implementer/agent.md"]).toContain("gh pr create --draft");
    expect(files["agents/reviewer/agent.md"]).toContain("prompts/grant.review-verdict.md");
    expect(files["prompts/grant.review-verdict.md"]).toContain("Never post the verdict with `gh pr comment`");
    expect(Object.values(files).every((content) => content.endsWith("\n"))).toBe(true);
  });
});
