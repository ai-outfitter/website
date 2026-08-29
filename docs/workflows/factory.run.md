This delivery workflow runs today on any GitHub repository through the [AI Outfitter GitHub App](https://github.com/apps/ai-outfitter). The declaration starts after issue triage has selected an implementation agent: either a deployed resident or the App-routed hosted agent. Nothing is added to your repository for the hosted path; your first pull request is the feature itself.

How the declaration maps to what actually runs:

| Declared step | What runs | Identity |
| --- | --- | --- |
| `implement`, `ready` | A direct assignment wakes a deployed resident through its forge channel. Otherwise the `ai-outfitter` label wakes the App router, which creates an `AgentTask(implement)` for the hosted agent. The selected agent implements on `agent/issue-<n>`, runs the tests, and opens the pull request. | resident identity or `ai-outfitter[bot]` |
| `review` | An `AgentTask(review)` in a fresh conversation reviews adversarially and returns its verdict over the internal task plane, bound to the task and the PR head SHA; the App posts the visible review. It shares the author's identity, so it cannot use GitHub's approve state. | `ai-outfitter[bot]` |
| `revise` | On `request-changes` the App creates one `AgentTask(revise)`; after that round a human decides. | App → resident |
| `merge` | On `approve` the App merges. Branch protection you configure still applies; the App comments when a merge is refused. | `ai-outfitter[bot]` |

### Install

[Install the App](https://github.com/apps/ai-outfitter), choose inference, press **Provision** — see [Start your first software factory](/docs/start/).

### Run

1. Open an issue with acceptance criteria a reviewer can check.
2. Assign a deployed resident, or label it `ai-outfitter` (mentioning `@ai-outfitter` is an equivalent App trigger).
3. A pull request named `agent/issue-<n>` appears, then a review with findings and a verdict.
4. `approve` merges and closes the issue; `request-changes` triggers one revision, then a second review.

### Repository controls drive the process

| Repository control | How it enables the agentic process |
| --- | --- |
| **Issue templates** | Give agents a clear starting point: a typed request, the context they need, and acceptance criteria they can verify. |
| **CODEOWNERS** | Requests the right agent or human reviewers when a pull request becomes ready, starting adversarial review without another handoff. |
| **Branch protection and auto-merge** | Hold the branch until required reviews and checks pass, then merge it without another manual step. |

### See it on a real repository

The reference run lives in [`ai-outfitter/factory-demo-target`](https://github.com/ai-outfitter/factory-demo-target), a deliberately tiny project with no agent configuration:

- the task: [issue #1](https://github.com/ai-outfitter/factory-demo-target/issues/1);
- the runs: the resident's task timeline in our cluster (private); the pull request and review are public on the target repository.
