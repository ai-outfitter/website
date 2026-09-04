---
title: Documentation
description: Find the right entry point into AI Outfitter.
---

AI Outfitter is a set of composable projects, not one monolith. Choose the
starting path that matches what you want to evaluate.

## Three starting paths

| Goal | What runs | Start here |
| --- | --- | --- |
| Manage shared agent configuration | The dashboard creates or updates an account or organization `.agents` repository; engineers run it through Outfitter and a supported local harness. | [Set up shared configuration](/docs/start/) |
| See one issue completed on hosted infrastructure | The GitHub App dispatches one issue to AI Outfitter's compute and inference. It does not use your `.agents` repository. | [Try one hosted issue](/docs/cloud/) |
| Operate agents on your infrastructure | [Actions](/docs/actions/) runs one-shot jobs today. Channels is alpha; the resident-agent operator and managed service are not public onboarding paths yet. | [Plan an adoption ramp](/docs/adoption-ramp/) |

The first and third paths build on portable `.agents` configuration. The
hosted issue path is a bounded product trial with its own runtime and defaults.

## Paths through the docs

- **New to the CLI:** follow [Getting started](/docs/outfitter/documentation/getting-started/).
- **Choosing components:** browse the [repository documentation](/docs/projects/).
- **Designing an adoption plan:** read [Move the control point outward](/docs/adoption-ramp/).
- **Seeing the system in motion:** explore the [workflow atlas](/workflows/).
- **Understanding composition:** read [Outfitter concepts](/docs/outfitter/documentation/concepts/).
- **Evaluating production boundaries:** read [Outfitter architecture](/docs/outfitter/architecture/).

Repository pages are generated from each project’s real `README.md` and `docs/`
tree. Every generated page links to the exact source commit and back to the
canonical repository for edits.
