---
title: Start your first software factory
description: Install the AI Outfitter GitHub App, pick inference, and label an issue. Your first pull request is the feature, adversarially reviewed and merged.
---

Three clicks, nothing added to your repository. AI Outfitter provisions a hosted resident agent and GitHub auto-merges its pull request after required CI and adversarial approval.

## 1. Install the App

[Install AI Outfitter](https://github.com/apps/ai-outfitter) on the repository you want to try it on. GitHub sends you back to the setup page for your installation.

## 2. Choose inference and provision

On the setup page pick **AI Outfitter inference** (nothing to configure) or **bring your own key** (provider, API key, optional endpoint and model), then press **Provision**. Within about a minute the page reports the resident ready: an agent running in our cluster in its own namespace, with your key — if you brought one — stored only there.

No workflow file, no repository secret, no settings change. Your key is never stored by the setup page.

## 3. Label an issue

Open an issue with acceptance criteria a reviewer can check and add the `ai-outfitter` label (a `@ai-outfitter` mention from a collaborator works too). The resident wakes, implements in a worktree, and opens a draft pull request as `ai-outfitter[bot]`. After required CI passes, it marks the pull request ready and enables auto-merge. CODEOWNERS requests a distinct adversarial-review agent; requested changes repeat implementation, CI, and review until approval lets GitHub merge.

## Add more agents

The [App's store](https://app.ai-outfitter.com/store) lists the catalog agents each [workflow](/workflows/) runs as. Pick one and the App commits it into your organization's or account's `.agents` repository — pushed to the default branch or opened as a pull request — with nothing to clone.

## What just ran

Every step is a node of the declared [Software Factory](/workflows/software-factory/) workflow — [see how they map](/workflows/software-factory/#run-it) — and the reference run lives on [`ai-outfitter/factory-demo-target`](https://github.com/ai-outfitter/factory-demo-target/issues/1), a repository with no agent configuration at all.

## Self-host it

The same `forge-app` image and operator CRDs run on your own cluster with your own GitHub App (or a Forgejo bot): the [agent-operator](/docs/agent-operator/) `ForgeIntegration` resource deploys the webhook endpoint per organization, and nothing is hosted by us.
