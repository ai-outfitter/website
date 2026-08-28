---
title: Start your first software factory
description: Install the AI Outfitter GitHub App and trigger the agent on an issue. Your first pull request is the feature, adversarially reviewed.
---

Two steps, nothing added to your repository. This is the [Software factory](/docs/workflows/factory/) workflow running on hosted runners; the App routes events, scopes a one-hour token to your repository, and merges.

## 1. Install the App

[Install AI Outfitter](https://github.com/apps/ai-outfitter) on the repository you want to try it on. That is the whole setup — no workflow file, no secret, no settings change.

## 2. Trigger the agent on an issue

Open an issue with acceptance criteria a reviewer can check, then do one of:

- add the `ai-outfitter` label;
- comment `@ai-outfitter implement this`;
- assign the agent login, where your organization has one.

Within seconds a run starts on our runners. You get a pull request named `agent/issue-<n>` opened by `ai-outfitter[bot]`, your own CI runs on it, and a second agent posts an adversarial review with findings and a verdict. `approve` merges and closes the issue; `request-changes` triggers one revision and a second review, then a human decides.

## What just ran

Every step above is a node of the declared workflow — [see how they map](/docs/workflows/factory/#run-it) — and you can watch the reference run on [`ai-outfitter/factory-demo-target`](https://github.com/ai-outfitter/factory-demo-target/issues/1), a repository with no agent configuration at all.

Inference runs on AI Outfitter's key for now; bringing your own key arrives with the setup page.
