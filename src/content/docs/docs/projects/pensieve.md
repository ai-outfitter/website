---
title: Pensieve
description: A designed evidence sink, collector set, and verifier for immutable agent-run records.
---

:::caution[Design stage]
Pensieve currently specifies the intended system; no implementation has been
written. Commands in its repository are illustrative.
:::

Pensieve is designed to collect session transcripts, tool calls, model
exchanges, patches, approvals, attestations, and related artifacts into a
write-once store. A verifier would then re-read records and check digests,
storage statements, retention floors, and declared capture gaps.

Its scope is storage proof, not policy judgment. Governance decides what must
be captured; Pensieve is intended to preserve and verify the resulting bytes.

- [Repository and design](https://github.com/ai-outfitter/pensieve)
- [Requirements](https://github.com/ai-outfitter/pensieve/tree/main/docs/requirements)

