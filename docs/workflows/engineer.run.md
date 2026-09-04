This workflow runs today with the community `engineer` profile: a bare bug
report becomes a scoped issue, a fix on a semantic branch, a CI-gated pull
request, a self-started adversarial review, and a human merge. The process
comes from the loadout — the prompt is only the report.

| Declared step | What runs | Identity |
| --- | --- | --- |
| `issue` | The `scoped-issues` skill reproduces the report and files one issue with checkable acceptance criteria. | human |
| `develop`, `draft`, `ci`, `ready` | Fix on a `fix/` branch with the regression test, draft pull request, required CI, mark ready. | human |
| `review`, `revise` | The engineer starts the adversarial review of its own pull request: one subagent per lens returns a review envelope, the engineer merges them, submits one formal review through the GitHub MCP, and fixes blockers. | human |
| `merge` | The human verifies the acceptance criteria and merges. | human |

### Run

[`ai-outfitter/outfitter-playground`](https://github.com/ai-outfitter/outfitter-playground)
is a sandbox with a seeded bug for exactly this run:

1. Generate your arena from the template and clone it:

   ```sh
   gh repo create outfitter-playground --template ai-outfitter/outfitter-playground --public --clone
   cd outfitter-playground
   ```

2. Start the engineer (the repository's `.agents` pins the community
   catalog and defaults to it):

   ```sh
   outfitter sync
   export GITHUB_PERSONAL_ACCESS_TOKEN="$(gh auth token)"
   outfitter run
   ```

3. Paste the bug report — nothing more:

   ```text
   Splitting $100 among 3 people loses a cent — `node bin/split.js 100 3`
   totals $99.99. The shares should always sum to the amount. Do not merge.
   ```

4. Watch the issue, branch, draft pull request, CI, self-started review,
   and formal review envelope appear on your arena; verify and merge
   yourself.
