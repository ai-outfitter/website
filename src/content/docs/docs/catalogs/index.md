---
title: Catalogs
description: Share versioned agents, skills, and organizational defaults without copying configuration.
---

Catalogs are `.agents` trees published for composition. Consumers reference a
catalog, pin a revision, and select the agents or capabilities they need by
slug.

- [`default-profiles`](https://github.com/ai-outfitter/default-profiles)
  provides the default Outfitter profiles.
- [`community-profiles`](https://github.com/ai-outfitter/community-profiles)
  holds community-contributed profiles.
- [`.agents`](https://github.com/ai-outfitter/.agents) is AI Outfitter's own
  organization catalog and a working example of dogfooding the convention.

Your organization can publish the same shape from its own repository. Pin
remote catalogs to an intentional revision so an upstream improvement enters
through review rather than silently changing a run.

Read the canonical [catalog documentation](https://github.com/ai-outfitter/outfitter/blob/main/docs/documentation/catalogs.md).

