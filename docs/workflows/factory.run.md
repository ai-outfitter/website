This workflow runs today on any GitHub repository through the [AI Outfitter GitHub App](https://github.com/apps/ai-outfitter). Nothing is added to your repository: the App dispatches a hosted runner with a one-hour token scoped to your repository, and your first pull request is the feature itself. The experience mirrors assigning an issue to a coding agent: trigger, wait, review the pull request.

How the declaration maps to what actually runs:

| Declared step | What runs | Identity |
| --- | --- | --- |
| `assign_issue` | You trigger the agent on the issue: assign the agent login, add the `ai-outfitter` label, or mention `@ai-outfitter`. GitHub cannot assign issues to an app, so the App is the router. | you |
| `implement`, `ready` | The `implement` job of the hosted runner: the `luce` profile implements on `agent/issue-<n>`, runs the tests, opens the pull request. Your CI runs on it. | `ai-outfitter[bot]` |
| `review` | The `review` job: a second agent run with an adversarial brief posts one review ending in a machine-readable verdict, `<!-- outfitter-verdict: approve -->` or `request-changes`. It shares the author's identity, so it cannot use GitHub's approve state. | `ai-outfitter[bot]` |
| `revise` | On `request-changes` the App dispatches the runner once more with the pull request number; after that round a human decides. | App → runner |
| `merge` | On `approve` the App merges. Branch protection you configure still applies; the App comments when a merge is refused. | `ai-outfitter[bot]` |

### Install

[Install the App](https://github.com/apps/ai-outfitter) on the repository. There is no step two.

### Run

1. Open an issue with acceptance criteria a reviewer can check.
2. Label it `ai-outfitter`, comment `@ai-outfitter`, or assign the agent login.
3. A pull request named `agent/issue-<n>` appears, then a review with findings and a verdict.
4. `approve` merges and closes the issue; `request-changes` triggers one revision, then a second review.

### See it on a real repository

The reference run lives in [`ai-outfitter/factory-demo-target`](https://github.com/ai-outfitter/factory-demo-target), a deliberately tiny project with no agent configuration:

- the task: [issue #1](https://github.com/ai-outfitter/factory-demo-target/issues/1);
- the runs: [factory-runner Actions](https://github.com/ai-outfitter/factory-runner/actions) (private to the AI Outfitter organization; the pull request and review are public on the target repository).

### What the declaration still promises that the app does not yet do

The YAML places `implement` in Kubernetes woken by Channels and `merge` in a separate merge bot. The shipped loop runs on hosted GitHub Actions and lets the App merge. Resident execution and a second App identity for a formal GitHub approval are later milestones of the [plan](https://github.com/ai-outfitter/gh-app/pull/10).
