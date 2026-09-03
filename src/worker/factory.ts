// The hosted software factory's pure decisions: which GitHub events start a
// run, what the runner is told, and how the run's branch is named. Nothing
// here talks to GitHub; webhooks.ts does the I/O.

/** Our private runner repository. The App dispatches this workflow with a
 * customer repository and issue plus a one-hour token scoped to that one
 * repository; the run implements the issue on AI Outfitter inference. */
export const RUNNER = {
  owner: "ai-outfitter",
  repo: "factory-runner",
  workflow: "outfitter-agent.yml",
  ref: "main",
} as const;

/** Label that routes an issue to the hosted run. */
export const TRIGGER_LABEL = "ai-outfitter";

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export type Trigger =
  | { kind: "labeled"; label: string }
  | { kind: "mentioned"; body: string; authorAssociation: string; authorType: string }
  | { kind: "assigned"; assignee: string };

export type IssueSubject = {
  repository: { full_name: string; owner: { login: string }; name: string };
  issue: { number: number; pull_request?: unknown };
  installationId: number;
};

type Payload = {
  action?: string;
  installation?: { id?: number } | null;
  repository?: { full_name?: string; name?: string; owner?: { login?: string } };
  issue?: { number?: number; pull_request?: unknown };
  label?: { name?: string } | null;
  assignee?: { login?: string } | null;
  comment?: { body?: string; author_association?: string; user?: { login?: string; type?: string } | null };
};

/** Translate a GitHub delivery into a trigger. Only issue events count: a
 * label or comment on a pull request is not a task. */
export function triggerFromWebhook(event: string, raw: unknown): Trigger | undefined {
  const payload = raw as Payload;
  if (event === "issues" && payload.action === "labeled") {
    return { kind: "labeled", label: payload.label?.name ?? "" };
  }
  if (event === "issues" && payload.action === "assigned") {
    return { kind: "assigned", assignee: payload.assignee?.login ?? "" };
  }
  if (event === "issue_comment" && payload.action === "created" && payload.comment) {
    return {
      kind: "mentioned",
      body: payload.comment.body ?? "",
      authorAssociation: payload.comment.author_association ?? "",
      authorType: payload.comment.user?.type ?? "",
    };
  }
  return undefined;
}

/** The issue a delivery is about, or null when the payload is not an issue
 * event we can act on (no installation, or a pull request). */
export function subjectFromWebhook(raw: unknown): IssueSubject | null {
  const payload = raw as Payload;
  const installationId = payload.installation?.id;
  const number = payload.issue?.number;
  const fullName = payload.repository?.full_name;
  const owner = payload.repository?.owner?.login;
  const name = payload.repository?.name;
  if (!installationId || !number || !fullName || !owner || !name) return null;
  if (payload.issue?.pull_request) return null;
  return { repository: { full_name: fullName, owner: { login: owner }, name }, issue: { number }, installationId };
}

/** The name people mention: the bot login without its `[bot]` suffix. */
export function mentionName(botLogin: string) {
  return botLogin.replace(/\[bot\]$/, "");
}

function mentionPattern(botLogin: string) {
  const name = mentionName(botLogin).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w@/])@${name}(?![\\w-])`, "i");
}

/** Whether an event starts a run. Every trigger is something a person with
 * write access does in the issue; the repository needs no setup. Labels are
 * already restricted to triage access by GitHub; a mention must come from a
 * person who owns, belongs to, or collaborates on the repository. */
export function startsRun(
  trigger: Trigger,
  options: { botLogin: string; triggerLabel?: string; assignee?: string },
) {
  switch (trigger.kind) {
    case "labeled":
      return trigger.label === (options.triggerLabel ?? TRIGGER_LABEL);
    case "assigned":
      return Boolean(options.assignee) && trigger.assignee === options.assignee;
    case "mentioned":
      return (
        trigger.authorType !== "Bot" &&
        TRUSTED_ASSOCIATIONS.has(trigger.authorAssociation) &&
        mentionPattern(options.botLogin).test(trigger.body)
      );
  }
}

/** The branch the runner works an issue on. */
export const agentBranch = (issue: number) => `agent/issue-${issue}`;

/** Inputs the hosted runner takes; all strings, as workflow_dispatch requires. */
export function runnerInputs(args: { repository: string; issue: number; pr?: number; token: string }) {
  return {
    repository: args.repository,
    issue_number: String(args.issue),
    pr_number: args.pr ? String(args.pr) : "",
    token: args.token,
  };
}
