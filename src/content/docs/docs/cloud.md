---
title: Complete an issue in the AI Outfitter cloud
description: Install the GitHub App, label an issue, and get a reviewed pull request back from AI Outfitter's own compute and inference.
---

The AI Outfitter cloud turns one issue into one reviewed pull request. It runs
on our compute and our inference. Your repository needs no workflow file, no
secret, and no agent configuration.

## 1. Install the App

[Open the dashboard](/dashboard/) and sign in with GitHub. Install the AI
Outfitter GitHub App on the account or organization that owns the repository.
Grant it the repositories you want the cloud to work in.

## 2. Route an issue to the cloud

Do one of these in the issue, as a person with write access:

- add the `ai-outfitter` label;
- comment with `@ai-outfitter` in the text.

Within a few seconds the App comments on the issue that it picked the work up.

## 3. Get the pull request

One hosted run does the whole loop:

1. An implementer agent works the issue on a branch named `agent/issue-<n>`,
   runs your tests, opens the pull request as `ai-outfitter[bot]` with
   `Closes #<n>`, and marks it ready.
2. A second, independent reviewer agent tries to break the change. It posts one
   review with findings and a verdict line, `approve` or `request-changes`.

A maintainer merges. The reviewer shares the author's identity, so GitHub does
not let it submit a formal approval; the verdict is in the review body.

## What the cloud can do in your repository

The run holds a token minted for that one repository and nothing else. The
token expires after one hour. It can read and write contents, pull requests,
and issues. It cannot reach any other repository the App is installed on.

## Limits in this release

- One run per issue. To run again, close the agent's pull request first, then
  label or mention again.
- Review feedback is not yet acted on automatically. Address it yourself or
  route a new issue.
- Assigning the App does not start a run. GitHub does not allow App identities
  as assignees.
- Runs use AI Outfitter's inference. Bring-your-own-key inference and
  self-hosted execution follow the [adoption ramp](/docs/adoption-ramp/).
