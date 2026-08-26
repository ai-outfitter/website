---
title: The .agents convention
description: Store agent configuration as portable, layered, reviewable files.
---

`.agents/` is an open directory convention for the configuration around a
coding agent: shared context, agent identities, skills, tools, models,
permissions, and knowledge.

```text
.agents/
  agents.md             # shared operating context
  system-prompt.md      # base prompt
  settings.yml          # default selection and sources
  mcp.json              # MCP servers
  models.json           # model configuration
  agents/<id>/agent.md  # identity and loadout
  skills/<id>/          # progressive capability packages
  knowledge/            # reference material
  commands/             # reusable commands
```

Outfitter resolves layers by identifier. Project configuration overrides a
person's configuration, which overrides pinned remote catalogs. This lets a
team share improvements without copying whole profiles or surrendering local
control.

The directory remains useful without Outfitter. Outfitter's role is resolution,
composition, validation, and launching the selected result through supported
harnesses.

Continue with the canonical documentation for
[concepts](https://github.com/ai-outfitter/outfitter/blob/main/docs/documentation/concepts.md),
[agents](https://github.com/ai-outfitter/outfitter/blob/main/docs/documentation/agents.md),
and [skills](https://github.com/ai-outfitter/outfitter/blob/main/docs/documentation/skills.md).

