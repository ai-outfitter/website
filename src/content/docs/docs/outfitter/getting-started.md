---
title: Getting started
description: Run Outfitter, create a reviewable agent configuration, and choose the next surface.
---

Start locally. A working delegated loop gives you something concrete to share
and automate.

## 1. Run Outfitter

```sh
npx @ai-outfitter/outfitter
```

Pi is bundled and hosts the setup walkthrough. Claude Code and Codex CLI are
supported as separately installed harnesses.

## 2. Keep configuration in `.agents/`

Your project or home `.agents/` tree is the source of truth for agents, skills,
MCP servers, model choices, permissions, and shared instructions. Commit project
configuration so the team can review it.

```text
.agents/
├── agents.md
├── settings.yml
├── agents/
├── skills/
├── knowledge/
└── mcp.json
```

## 3. Prove one useful workflow

Choose a bounded task with a visible acceptance check. Run it locally until the
profile reliably produces reviewable work. Do not automate a workflow that has
not worked manually.

## 4. Choose the next surface

- Use [Actions](/docs/actions/) when an issue, pull request, push, or
  schedule should run the profile in GitHub Actions.
- Use [Channels](/docs/channels/) when a message or external event should
  wake a long-running session.
- Follow [Agent Operator](/docs/agent-operator/) when a resident agent
  belongs in Kubernetes. It is currently design-stage software.
- Add [Evals](/docs/evals/) before changing models or profiles at scale.

For the complete CLI walkthrough, use the
[canonical Outfitter getting-started guide](https://github.com/ai-outfitter/outfitter/blob/main/docs/documentation/getting-started.md).
