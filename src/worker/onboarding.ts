import type { Octokit } from "@octokit/core";
import type { Change } from "./management";

export const PLAYGROUND_UPSTREAM = { owner: "ai-outfitter", repo: "outfitter-playground" } as const;
export const PLAYGROUND_REPOSITORY = "outfitter-playground";
export const LOCAL_ENGINEER = "local-engineer";
export const ONBOARDING_WORKFLOWS = ["engineer", "software-factory", "founder"] as const;

export type Playground = {
  repository: { fullName: string; url: string; defaultBranch: string; created: boolean };
  issue: { number: number; url: string; title: string; created: boolean };
};

const PLAYGROUND_ISSUE_TITLE = "split loses cents on uneven amounts";

export function playgroundIssueBody(login: string) {
  return `The seeded exhibit bug of the ${login} playground, filed so a local engineering agent can take one bounded change from issue to reviewed pull request without touching anything that matters.

Splitting $100.00 among 3 people loses a cent: every share is floored to $33.33, so the shares total $99.99 and nobody pays the last cent.

## Reproduce

\`\`\`sh
node bin/split.js 100 3
\`\`\`

Output today:

\`\`\`text
person 1: $33.33
person 2: $33.33
person 3: $33.33
total:    $99.99
\`\`\`

The bug is the \`Math.floor\` share in \`src/split.js\`: the remainder cents after integer division are dropped instead of being distributed.

## Acceptance criteria

- \`node bin/split.js 100 3\` MUST print shares that total exactly \`$100.00\` (e.g. \`$33.34, $33.33, $33.33\`; how the extra cents are assigned is the implementer's choice, but shares MUST differ by at most one cent).
- \`split(amount, people)\` MUST return shares whose sum equals the input amount for every valid input, not just this example.
- A regression test covering an uneven split (such as \`split(100, 3)\`) MUST be added to \`test/split.test.js\` and assert the shares sum to the amount.
- \`npm test\` MUST pass.
- No other behavior changes.

## Delivery

Work on a branch in a git worktree, open a draft pull request that references this issue, wait for CI, mark it ready, and request the adversarial review. The reviewer submits a formal pull request review.`;
}

function agentFile(path: string, content: string): Change {
  return { path, action: "add", before: null, after: content.endsWith("\n") ? content : `${content}\n`, mode: "100644" };
}

/** Files the onboarding plan adds beside settings.yml so a laptop can run the engineer workflow without a resident agent. */
export function localEngineeringFiles(login: string): Change[] {
  return [
    agentFile(`agents/${LOCAL_ENGINEER}/agent.md`, `---
name: ${LOCAL_ENGINEER}
description: Local engineering lead that takes one issue to a merged pull request through an implementer and an independent reviewer.
inherits: [engineer]
subagents: [implementer, reviewer]
append_system_prompt:
  - file: prompts/practice.local-delegation.md
---

# Local engineer

You lead one issue in ${login} from acceptance criteria to a merged pull
request. You run on a contributor's workstation with that contributor's
GitHub identity. No resident agent exists yet, so nothing happens unless you
delegate it.

1. Read the issue. If the request names no issue, create one with acceptance
   criteria (\`gh issue create\`) and use it.
2. Delegate implementation to the \`implementer\` subagent. Pass the issue
   number, the acceptance criteria, and the repository path. The implementer
   works in its own git worktree and opens a draft pull request.
3. Watch the draft pull request's checks (\`gh pr checks <number> --watch\`).
   Send failures back to the implementer until every required check passes.
4. Mark the pull request ready (\`gh pr ready <number>\`).
5. Delegate the review to the \`reviewer\` subagent with the pull request
   number. Do not review the change yourself.
6. When the reviewer requests changes, send each finding to the implementer,
   then delegate the review again on the new head.
7. When the review carries no blocking finding, merge as the human
   (\`gh pr merge <number> --squash --delete-branch\`) and report the merged
   pull request URL, the review URL, and the worktree that can be removed.
`),
    agentFile("agents/implementer/agent.md", `---
name: implementer
description: Implements one bounded change in an isolated git worktree and opens a draft pull request.
inherits: [engineer]
---

# Implementer

You implement exactly one issue in an isolated git worktree and hand back a
draft pull request.

- Create the worktree from the default branch before you edit anything:
  \`git fetch origin && git worktree add -b feat/<slug> ../<repo>.worktrees/feat/<slug> origin/main\`.
  Do all work inside that worktree.
- Satisfy every acceptance criterion in the issue and nothing beyond it.
- Run the repository's checks (\`npm test\`, \`npm run check\`, or what the
  repository documents) before you push.
- Commit with a conventional message that references the issue, push the
  branch, and open a draft pull request (\`gh pr create --draft\`) whose body
  links the issue and lists the changes.
- Report the pull request number, the worktree path, the commands you ran,
  and any risk you could not verify.
`),
    agentFile("agents/reviewer/agent.md", `---
name: reviewer
description: Independent adversarial reviewer that submits one formal pull request review.
inherits: [code-review]
append_system_prompt:
  - file: prompts/grant.review-verdict.md
---

# Reviewer

Review the pull request you are given as an independent peer, following the
\`code-review\` skill and the adversarial-review practice. Deliver the verdict
as one formal pull request review, never as an issue comment.
`),
    agentFile("prompts/practice.local-delegation.md", `## Practice: local delegation

Delegate one bounded outcome at a time and reconcile the evidence before you
move on.

- Every delegation names the issue, the acceptance criteria, the repository,
  and the evidence you expect back (a pull request number, a review URL).
- The implementer owns the branch and the fixes. The reviewer owns the
  verdict. You own the sequence, the CI gate, and the merge.
- Never mark a red pull request ready and never merge without a review that
  carries no blocking finding.
- A subagent result counts only when its evidence satisfies the criteria;
  re-delegate when it does not.
`),
    agentFile("prompts/grant.review-verdict.md", `## Grant: formal review verdict

This organization grants its local reviewer a formal verdict on every pull
request it reviews.

- Submit exactly one review through the pull request review API
  (\`gh api repos/{owner}/{repo}/pulls/{number}/reviews\` or the GitHub MCP
  pending-review flow). Never post the verdict with \`gh pr comment\` or as an
  issue comment.
- Anchor each finding as an inline review comment on its file and line.
- When any finding blocks, submit the review with event \`REQUEST_CHANGES\`.
- When no finding blocks, submit the review with event \`APPROVE\`. GitHub
  rejects an approval from the pull request's own author; when that happens,
  submit the same review with event \`COMMENT\` and open the body with the
  word \`APPROVE\` so the lead can merge on that verdict.
- State what you did not verify.
`),
  ];
}

async function wait(ms: number) { await new Promise((resolve) => setTimeout(resolve, ms)); }

async function existingRepository(client: Octokit, owner: string, repo: string) {
  try {
    const response = await client.request("GET /repos/{owner}/{repo}", { owner, repo });
    return response.data;
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

async function forkedRepository(client: Octokit, login: string, accountType: "User" | "Organization") {
  await client.request("POST /repos/{owner}/{repo}/forks", {
    ...PLAYGROUND_UPSTREAM,
    name: PLAYGROUND_REPOSITORY,
    default_branch_only: true,
    ...(accountType === "Organization" ? { organization: login } : {}),
  });
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const created = await existingRepository(client, login, PLAYGROUND_REPOSITORY);
    if (created) {
      try {
        await client.request("GET /repos/{owner}/{repo}/commits/{ref}", { owner: login, repo: PLAYGROUND_REPOSITORY, ref: String(created.default_branch) });
        return created;
      } catch (error) {
        if (![404, 409].includes((error as { status?: number }).status ?? 0)) throw error;
      }
    }
    await wait(1000);
  }
  throw new Error("GitHub has not finished creating the playground fork; try again in a moment");
}

export async function findPlayground(client: Octokit, login: string): Promise<Playground | null> {
  const repo = await existingRepository(client, login, PLAYGROUND_REPOSITORY);
  if (!repo) return null;
  const issue = await findIssue(client, login);
  return {
    repository: { fullName: String(repo.full_name), url: String(repo.html_url), defaultBranch: String(repo.default_branch), created: false },
    issue: issue ?? { number: 0, url: "", title: PLAYGROUND_ISSUE_TITLE, created: false },
  };
}

async function findIssue(client: Octokit, login: string) {
  const issues = await client.request("GET /repos/{owner}/{repo}/issues", { owner: login, repo: PLAYGROUND_REPOSITORY, state: "open", per_page: 100 });
  const found = issues.data.find((issue) => !issue.pull_request && issue.title === PLAYGROUND_ISSUE_TITLE);
  return found ? { number: Number(found.number), url: String(found.html_url), title: PLAYGROUND_ISSUE_TITLE, created: false } : null;
}

export async function createPlayground(client: Octokit, login: string, accountType: "User" | "Organization"): Promise<Playground> {
  const existing = await existingRepository(client, login, PLAYGROUND_REPOSITORY);
  const repo = existing ?? await forkedRepository(client, login, accountType);
  const created = !existing;
  if (created || !repo.has_issues) {
    await client.request("PATCH /repos/{owner}/{repo}", { owner: login, repo: PLAYGROUND_REPOSITORY, has_issues: true });
  }
  if (created) {
    try { await client.request("PUT /repos/{owner}/{repo}/actions/permissions", { owner: login, repo: PLAYGROUND_REPOSITORY, enabled: true }); }
    catch (error) { if ((error as { status?: number }).status !== 403) throw error; }
  }
  const issue = await findIssue(client, login) ?? await createIssue(client, login);
  return {
    repository: { fullName: String(repo.full_name), url: String(repo.html_url), defaultBranch: String(repo.default_branch), created },
    issue,
  };
}

async function createIssue(client: Octokit, login: string) {
  const response = await client.request("POST /repos/{owner}/{repo}/issues", { owner: login, repo: PLAYGROUND_REPOSITORY, title: PLAYGROUND_ISSUE_TITLE, body: playgroundIssueBody(login) });
  return { number: Number(response.data.number), url: String(response.data.html_url), title: PLAYGROUND_ISSUE_TITLE, created: true };
}
