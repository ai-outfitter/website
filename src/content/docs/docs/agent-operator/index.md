---
title: Agent Operator
description: Kubernetes primitives for resident autonomous agents.
---

:::caution[Design stage]
The CRDs and controller are specified but not yet implemented. Use this page to
understand direction, not as an installation promise.
:::

Agent Operator defines narrow Kubernetes primitives for a resident agent: a
bounded namespace workspace, generic secret and configuration exposure, catalog
resolution, and process execution. Communication channels and application tools
compose at the agent layer instead of being baked into the operator.

The intended split keeps the runtime generic. An organization owns its agent
images and catalogs, while an `Agent` resource chooses the runtime for each
resident identity.

- [Repository and current status](https://github.com/ai-outfitter/agent-operator)
- [Architecture](https://github.com/ai-outfitter/agent-operator/blob/main/docs/architecture.md)
- [Specified quick start](https://github.com/ai-outfitter/agent-operator/blob/main/docs/documentation/quick-start.md)

