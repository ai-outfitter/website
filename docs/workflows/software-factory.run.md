This delivery workflow begins with an issue created by a human or agent. Coding work is assigned to a resident agent running on infrastructure you operate. Managed resident deployment is planned, not available today.

How the declaration maps to what actually runs:

| Declared step | What runs | Identity |
| --- | --- | --- |
| `prepare_issue`, `assign` | Accept a human- or agent-created issue, categorize it only when it is untyped, and assign or confirm coding work to a resident. | human or agent → resident |
| `worktree`, `research`, `implement`, `draft` | The resident creates a worktree, researches, implements, iterates, and pushes a draft pull request. | resident identity or `ai-outfitter[bot]` |
| `ci`, `ready`, `auto_merge` | Required CI gates readiness. After it passes, the resident undrafts the pull request and enables GitHub auto-merge. | resident identity or `ai-outfitter[bot]` |
| `review`, `revise` | CODEOWNERS requests an adversarial-review agent with a GitHub identity distinct from the implementer. Requested changes return to implementation, CI, and review until approval. | distinct review agent |
| `merge` | GitHub auto-merges only after required CI and the required agent approval. | GitHub |

### Run

1. Open an issue with acceptance criteria a reviewer can check.
2. Assign a resident agent running through your current harness or infrastructure.
3. A draft pull request appears and stays draft until required CI passes.
4. CODEOWNERS requests the distinct adversarial reviewer. Requested changes repeat revision, CI, and review; approval lets GitHub auto-merge.

### Repository controls drive the process

| Repository control | How it enables the agentic process |
| --- | --- |
| **Issue templates** | Give agents a clear starting point: a typed request, the context they need, and acceptance criteria they can verify. |
| **CODEOWNERS** | Requests the right agent or human reviewers when a pull request becomes ready, starting adversarial review without another handoff. |
| **Branch protection and auto-merge** | Hold the branch until required reviews and checks pass, then merge it without another manual step. |

### See it on a real repository

The reference run lives in [`ai-outfitter/factory-demo-target`](https://github.com/ai-outfitter/factory-demo-target), a deliberately tiny project with no agent configuration:

- the task: [issue #1](https://github.com/ai-outfitter/factory-demo-target/issues/1);
- the runs: the pull request and review are public on the target repository.
