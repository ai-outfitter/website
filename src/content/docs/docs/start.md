---
title: Start your first software factory
description: Install the AI Outfitter GitHub App, pick inference, and label an issue. Your first pull request is the feature, adversarially reviewed and merged.
---

Three clicks, nothing added to your repository. AI Outfitter hosts your organization's resident agent — the App itself is the agent — and merges the reviewed pull request for you.

## 1. Install the App

[Install AI Outfitter](https://github.com/apps/ai-outfitter) on the repository you want to try it on. GitHub sends you back to the setup page for your installation.

## 2. Choose inference and provision

On the setup page pick **AI Outfitter inference** (nothing to configure) or **bring your own key** (provider, API key, optional endpoint and model), then press **Provision**. Within about a minute the page reports the resident ready: an agent running in our cluster in its own namespace, with your key — if you brought one — stored only there.

No workflow file, no repository secret, no settings change. Your key is never stored by the setup page.

## 3. Label an issue

Open an issue with acceptance criteria a reviewer can check and add the `ai-outfitter` label (a `@ai-outfitter` mention from a collaborator works too). The resident wakes, implements on `agent/issue-<n>`, opens the pull request as `ai-outfitter[bot]`, and your own CI runs on it. A second run reviews it adversarially in a fresh conversation and returns a verdict over the task plane; `approve` merges and closes the issue, `request-changes` revises once and reviews again, then a human decides.

## Add more agents

The [App's store](https://app.ai-outfitter.com/store) lists the catalog agents each [workflow](/docs/workflows/) runs as. Pick one and the App commits it into your organization's or account's `.agents` repository — pushed to the default branch or opened as a pull request — with nothing to clone.

## What just ran

Every step is a node of the declared [Software factory](/docs/workflows/factory/) workflow — [see how they map](/docs/workflows/factory/#run-it) — and the reference run lives on [`ai-outfitter/factory-demo-target`](https://github.com/ai-outfitter/factory-demo-target/issues/1), a repository with no agent configuration at all.

## Self-host it

The same `forge-app` image and operator CRDs run on your own cluster with your own GitHub App (or a Forgejo bot): the [agent-operator](/docs/agent-operator/) `ForgeIntegration` resource deploys the webhook endpoint per organization, and nothing is hosted by us.
