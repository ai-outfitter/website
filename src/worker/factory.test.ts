import { describe, expect, it } from "vitest";
import { agentBranch, mentionName, runnerInputs, startsRun, subjectFromWebhook, triggerFromWebhook } from "./factory";

const bot = { botLogin: "ai-outfitter[bot]" };

describe("triggerFromWebhook", () => {
  it("reads a label, an assignment, and a comment", () => {
    expect(triggerFromWebhook("issues", { action: "labeled", label: { name: "ai-outfitter" } })).toEqual({ kind: "labeled", label: "ai-outfitter" });
    expect(triggerFromWebhook("issues", { action: "assigned", assignee: { login: "luce" } })).toEqual({ kind: "assigned", assignee: "luce" });
    expect(
      triggerFromWebhook("issue_comment", { action: "created", comment: { body: "@ai-outfitter go", author_association: "OWNER", user: { type: "User" } } }),
    ).toEqual({ kind: "mentioned", body: "@ai-outfitter go", authorAssociation: "OWNER", authorType: "User" });
  });

  it("ignores other events and actions", () => {
    expect(triggerFromWebhook("issues", { action: "opened" })).toBeUndefined();
    expect(triggerFromWebhook("pull_request", { action: "labeled", label: { name: "ai-outfitter" } })).toBeUndefined();
    expect(triggerFromWebhook("issue_comment", { action: "edited", comment: { body: "@ai-outfitter" } })).toBeUndefined();
  });
});

describe("startsRun", () => {
  it("accepts the trigger label only", () => {
    expect(startsRun({ kind: "labeled", label: "ai-outfitter" }, bot)).toBe(true);
    expect(startsRun({ kind: "labeled", label: "bug" }, bot)).toBe(false);
    expect(startsRun({ kind: "labeled", label: "agent" }, { ...bot, triggerLabel: "agent" })).toBe(true);
  });

  it("accepts a mention from a trusted person, not from a bot or an outsider", () => {
    const mention = (extra: Partial<{ body: string; authorAssociation: string; authorType: string }>) =>
      startsRun({ kind: "mentioned", body: "please @ai-outfitter", authorAssociation: "MEMBER", authorType: "User", ...extra }, bot);
    expect(mention({})).toBe(true);
    expect(mention({ authorAssociation: "NONE" })).toBe(false);
    expect(mention({ authorType: "Bot" })).toBe(false);
    expect(mention({ body: "email me@ai-outfitter.com" })).toBe(false);
    expect(mention({ body: "@ai-outfitter-bot" })).toBe(false);
  });

  it("accepts an assignment only when an assignee login is configured", () => {
    expect(startsRun({ kind: "assigned", assignee: "luce" }, bot)).toBe(false);
    expect(startsRun({ kind: "assigned", assignee: "luce" }, { ...bot, assignee: "luce" })).toBe(true);
  });
});

describe("subjectFromWebhook", () => {
  const payload = { installation: { id: 7 }, repository: { full_name: "acme/app", name: "app", owner: { login: "acme" } }, issue: { number: 3 } };

  it("names the issue, repository, and installation", () => {
    expect(subjectFromWebhook(payload)).toEqual({ repository: { full_name: "acme/app", owner: { login: "acme" }, name: "app" }, issue: { number: 3 }, installationId: 7 });
  });

  it("rejects pull requests and deliveries without an installation", () => {
    expect(subjectFromWebhook({ ...payload, issue: { number: 3, pull_request: {} } })).toBeNull();
    expect(subjectFromWebhook({ ...payload, installation: null })).toBeNull();
  });
});

describe("runner contract", () => {
  it("names the branch and stringifies dispatch inputs", () => {
    expect(agentBranch(12)).toBe("agent/issue-12");
    expect(runnerInputs({ repository: "acme/app", issue: 12, token: "t" })).toEqual({ repository: "acme/app", issue_number: "12", pr_number: "", token: "t" });
    expect(runnerInputs({ repository: "acme/app", issue: 12, pr: 4, token: "t" }).pr_number).toBe("4");
    expect(mentionName("ai-outfitter[bot]")).toBe("ai-outfitter");
  });
});
