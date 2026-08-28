---
title: Start your first software factory
description: Install the AI Outfitter GitHub App, merge one workflow file, assign an issue, and get an adversarially reviewed pull request.
---

Ten minutes, one repository, one file. This is the [Software factory](/docs/workflows/factory/) workflow running on your own GitHub Actions; the App routes events and merges, nothing else.

## 1. Install the App

[Install AI Outfitter](https://github.com/apps/ai-outfitter) on the organization or repository you want to try it on. GitHub sends you back to the setup page for that installation.

## 2. Merge the one file

On the setup page choose the repository and the login that will receive assignments, then **Open the workflow PR**. The App opens a pull request adding `.github/workflows/outfitter-agent.yml` — the whole footprint. Before merging it:

- add `OPENAI_API_KEY` as a repository or organization secret (bring your own key; hosted inference is coming);
- turn on *Settings → Actions → General → Allow GitHub Actions to create and approve pull requests*.

Merge it.

## 3. Assign an issue

Open an issue with acceptance criteria a reviewer can check, and assign it to the login you chose. Under **Actions → AI Outfitter agent** the `implement` job starts, then the `review` job. You get a pull request named `agent/issue-<n>` and a review ending in a verdict; `approve` merges and closes the issue, `request-changes` revises once and reviews again.

## What just ran

Every step above is a node of the declared workflow — [see how they map](/docs/workflows/factory/#run-it) — and you can watch the reference run on [`ai-outfitter/factory-demo-target`](https://github.com/ai-outfitter/factory-demo-target/actions/workflows/outfitter-agent.yml).
