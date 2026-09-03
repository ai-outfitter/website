---
title: Manage your first agent workflow
description: Connect the AI Outfitter GitHub App and manage a reviewable workflow bundle in an account or organization .agents repository.
---

The dashboard manages one exact repository per GitHub account or organization:
`.agents`. It previews every structured change before applying it.

## 1. Install the App

[Open the dashboard](/dashboard/) and sign in with GitHub. Add the AI Outfitter
GitHub App to a personal account or organization. GitHub returns you to the
dashboard after installation.

## 2. Choose an account and workflow

Select the account whose `.agents` repository you want to manage, then select a
catalog workflow. The dashboard reports whether the repository already exists
and whether its selected workflow is ready for local execution.

If `.agents` is absent, create it from the dashboard. The GitHub App never
inspects arbitrary workload repositories for nested configuration.

## 3. Preview and apply

Preview the exact files that the workflow adds, updates, or deletes. Apply an
initial commit when creating the repository, or open a pull request against an
existing repository's default branch.

## Or let the cloud do it

Once the App is installed you can skip the local setup for one issue: add the
`ai-outfitter` label or mention `@ai-outfitter` and a hosted run opens a
reviewed pull request on our compute and inference. See
[complete an issue in the AI Outfitter cloud](/docs/cloud/).

## What is planned

The dashboard includes noninteractive roadmap cards for GitHub Actions setup,
resident deployment, bring-your-own-key inference, and managed operations.
These capabilities are not available yet.

## Understand the workflow

Each catalog workflow has a declared graph in the [workflow atlas](/workflows/).
Use it to inspect actors, triggers, environments, and handoffs before adopting
the corresponding bundle.

## Run it

Use the generated `.agents` configuration with Outfitter and the execution
surface you already operate. See the [adoption ramp](/docs/adoption-ramp/) for
the current local, GitHub Actions, and operator-based paths.
