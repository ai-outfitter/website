---
title: Agent Operator
description: Kubernetes primitives for resident autonomous agents.
---

:::note[Alpha · actively used]
Agent Operator is implemented, released, and actively used to run resident
agents in Kubernetes. Its APIs and deployment model are still evolving, so pin
a release and review its changelog before upgrading.
:::

Agent Operator provides narrow Kubernetes primitives for a resident agent: a
bounded namespace workspace, generic secret and configuration exposure, catalog
resolution, and process execution. Communication channels and application tools
compose at the agent layer instead of being baked into the operator.

The intended split keeps the runtime generic. An organization owns its agent
images and catalogs, while an `Agent` resource chooses the runtime for each
resident identity.

- [Repository and releases](https://github.com/ai-outfitter/agent-operator)
- [Architecture](https://github.com/ai-outfitter/agent-operator/blob/main/docs/architecture.md)
- [Install and run an agent](https://github.com/ai-outfitter/agent-operator/blob/main/docs/documentation/quick-start.md)
- [Deploy a catalog of agents](https://github.com/ai-outfitter/agent-operator/tree/main/actions/deploy-catalog)
