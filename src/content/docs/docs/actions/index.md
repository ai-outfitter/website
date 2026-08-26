---
title: Actions
description: Run Outfitter profiles headlessly from GitHub Actions triggers.
---

`ai-outfitter/actions` assembles an Outfitter profile and launches it in a
one-shot GitHub Actions job. Pull-request state, issue assignment, pushes,
schedules, and manual dispatches can all become bounded agent work.

Typical uses include scheduled commit review, review when a pull request leaves
draft, sensitive-path audits, and assigned-task implementation.

```yaml
- uses: ai-outfitter/actions@v1
  with:
    agent: reviewer
    source: my-org/agent-catalog
    source-ref: v1.2.0
    prompt: Review this pull request and post exact findings.
```

Pin catalog sources and grant the workflow only the permissions its task needs.

- [Repository](https://github.com/ai-outfitter/actions)
- [Workflow examples](https://github.com/ai-outfitter/actions/tree/main/examples)
- [Agentic workflow design](https://github.com/ai-outfitter/actions/blob/main/docs/agentic-workflows.md)

