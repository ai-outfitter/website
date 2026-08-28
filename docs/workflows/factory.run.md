This workflow runs today on any GitHub repository through the [AI Outfitter GitHub App](https://github.com/apps/ai-outfitter). The app adds one file to your repository and nothing else; the agents run in your own GitHub Actions on your inference key. The experience mirrors assigning an issue to a coding agent: assign, wait, review the pull request.

How the declaration maps to what actually runs:

| Declared step | What runs | Identity |
| --- | --- | --- |
| `assign_issue` | You assign the issue to the resident login the workflow declares (`OUTFITTER_ASSIGNEE`). GitHub cannot assign issues to an app, so the assignee is a login and the app is the router. | you |
| `implement`, `ready` | The `implement` job of `.github/workflows/outfitter-agent.yml`: the `luce` profile implements on `agent/issue-<n>`, runs the tests, opens the pull request. | `github-actions[bot]` in your repository |
| `review` | The `review` job: a second agent run with an adversarial brief posts one review ending in a machine-readable verdict, `<!-- outfitter-verdict: approve -->` or `request-changes`. It cannot use GitHub's approve state — it shares the author's identity. | `github-actions[bot]` |
| `revise` | On `request-changes` the app dispatches the workflow once more with the pull request number; after that round a human decides. | app → your Actions |
| `merge` | On `approve` the app merges with its installation token. Branch protection you configure still applies; the app comments when a merge is refused. | `ai-outfitter[bot]` |

### Install

1. Install the app on your organization or repository: [github.com/apps/ai-outfitter](https://github.com/apps/ai-outfitter). GitHub returns you to the setup page for your installation.
2. On the setup page, pick the repository and the login that will receive assignments, then **Open the workflow PR**. The app opens a pull request adding `.github/workflows/outfitter-agent.yml`. Review it — it is the whole footprint.
3. Before merging that pull request: add `OPENAI_API_KEY` as a repository or organization secret, and enable *Settings → Actions → General → Allow GitHub Actions to create and approve pull requests*.
4. Merge the pull request.

### Run

1. Open an issue with acceptance criteria a reviewer can check.
2. Assign it to the declared login. The `implement` job starts within seconds; watch it under **Actions → AI Outfitter agent**.
3. A pull request named `agent/issue-<n>` appears, then a review with findings and a verdict.
4. `approve` merges and closes the issue; `request-changes` triggers one revision, then a second review.

### See it on a real repository

The reference run lives in [`ai-outfitter/factory-demo-target`](https://github.com/ai-outfitter/factory-demo-target), a deliberately tiny project with no agent configuration of its own:

- the task: [issue #1](https://github.com/ai-outfitter/factory-demo-target/issues/1);
- the one installed file: [pull request #2](https://github.com/ai-outfitter/factory-demo-target/pull/2);
- the runs: [Actions](https://github.com/ai-outfitter/factory-demo-target/actions/workflows/outfitter-agent.yml).

### What the declaration still promises that the app does not yet do

The YAML places `implement` in Kubernetes woken by Channels and `merge` in a separate merge bot. The shipped loop runs both in your Actions and lets the app merge. Hosted resident execution and a second app identity for a formal GitHub approval are later milestones of the [plan](https://github.com/ai-outfitter/gh-app/pull/9).
