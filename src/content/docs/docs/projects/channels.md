---
title: Channels
description: Turn external events into safe task wakes for long-running Pi sessions.
---

Channels watches supported communication and forge sources, then wakes a running
session only when a source detects matching work. The wake contains a trusted,
body-free task reference; the agent fetches exact content through channel tools
inside explicit untrusted-content markers.

Sources include email, Signal, GitHub, Forgejo, Slack, agent-to-agent messaging,
and compatible chat systems. A long-running interactive or RPC session is
required; one-shot print mode exits too soon to receive events.

Channels is alpha software. Its existing `v1.x` releases are not a stability
contract; pin exact revisions and adopt changes deliberately.

- [Repository and installation](https://github.com/ai-outfitter/channels)
- [Source documentation](https://github.com/ai-outfitter/channels/tree/main/docs)

