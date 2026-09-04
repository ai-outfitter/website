This is the target operating model for a resident agent, not a public
quick-start. Its individual building blocks are being exercised, but the full
path below is not yet packaged for onboarding.

How the declaration maps to what actually runs:

| Declared step | What runs | Identity |
| --- | --- | --- |
| `prepare_issue`, `assign` | Accept a human- or agent-created issue, categorize it only when it is untyped, and assign or confirm coding work to a resident. | human or agent → resident |
| `worktree`, `research`, `implement`, `draft` | The resident creates a worktree, researches, implements, iterates, and pushes a draft pull request. | resident identity or `ai-outfitter[bot]` |
| `ci`, `ready`, `auto_merge` | Required CI gates readiness. After it passes, the resident undrafts the pull request and enables GitHub auto-merge. | resident identity or `ai-outfitter[bot]` |
| `review`, `revise` | CODEOWNERS requests an adversarial-review agent with a GitHub identity distinct from the implementer. Requested changes return to implementation, CI, and review until approval. | distinct review agent |
| `merge` | GitHub auto-merges only after required CI and the required agent approval. | GitHub |

### Evaluate the current pieces

| Available path | What it demonstrates | What it does not demonstrate |
| --- | --- | --- |
| [Local engineer workflow](/workflows/engineer/) | Shared configuration, issue scoping, implementation, CI, self-started review, and human merge. | Resident intake, a distinct forge identity, or automatic merge. |
| [Hosted issue quickstart](/docs/cloud/) | A one-shot implementer and independent reviewer on AI Outfitter compute and inference. | Your `.agents` configuration, a resident session, CODEOWNERS routing, or automatic merge. |
| [Actions](/docs/actions/) | Your profile running headlessly from a GitHub event or schedule. | A long-running resident process or the complete graph on this page. |

### Repository controls drive the process

| Repository control | How it enables the agentic process |
| --- | --- |
| **Issue templates** | Give agents a clear starting point: a typed request, the context they need, and acceptance criteria they can verify. |
| **CODEOWNERS** | Requests the right agent or human reviewers when a pull request becomes ready, starting adversarial review without another handoff. |
| **Branch protection and auto-merge** | Hold the branch until required reviews and checks pass, then merge it without another manual step. |

### Inspect hosted-run evidence

The hosted path has public evidence in
[`ai-outfitter/factory-demo-target`](https://github.com/ai-outfitter/factory-demo-target),
a deliberately tiny project with no agent configuration. It demonstrates the
hosted row above, not the complete resident workflow:

- the task: [issue #7](https://github.com/ai-outfitter/factory-demo-target/issues/7);
- the output: [pull request #8](https://github.com/ai-outfitter/factory-demo-target/pull/8), including its independent review.
