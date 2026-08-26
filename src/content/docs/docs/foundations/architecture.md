---
title: Architecture
description: See how configuration, execution, communication, quality, and evidence remain separate composable layers.
---

AI Outfitter separates concerns so an organization can adopt one boundary at a
time and replace implementations without rewriting its agent configuration.

```text
catalogs and .agents trees
            │
            ▼
        Outfitter ───────► local harness
            │
      ┌─────┴─────┐
      ▼           ▼
   Actions   Agent Operator
      │           │
      └─────┬─────┘
            ▼
         Channels
            │
      ┌─────┼─────────┐
      ▼     ▼         ▼
   Evals  Pensieve   Link
```

- **Configuration:** Outfitter and catalogs compose the profile.
- **Execution:** a local harness, Actions, or Agent Operator runs it.
- **Communication:** Channels turns external events into body-free task wakes.
- **Quality:** Deepwork structures jobs; Evals measures behavior; Autoimprove
  explores controlled skill improvement.
- **Evidence and governance:** Pensieve is designed to preserve immutable run
  evidence; Link audits signals visible in repositories and forge rules.

The diagram shows relationships, not a required stack. Each component owns a
narrow contract and SHOULD remain replaceable.

