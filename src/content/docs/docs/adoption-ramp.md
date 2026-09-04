---
title: Move the control point outward
description: A beginner-friendly path from using an agent beside you to running trusted, reviewable agent workflows for a team.
---

The adoption ramp is a safe way to give coding agents more responsibility over
time. You start with an agent helping while you work. After a workflow succeeds
reliably, you can let the agent perform more of it without you sitting at the
keyboard.

You do not need Kubernetes, an evaluation system, or every AI Outfitter project
to begin. Start with one small task on your own machine.

## What is a control point?

A **control point** is a moment when a person must start the work, make a
decision, or approve what happens next.

If you write every line and use an agent only for suggestions, you control every
edit. If you give an agent a task and review its pull request, your control
points have moved outward: you define the task and approve the result, while the
agent handles the implementation in between.

The goal is not to remove people. It is to spend human attention on goals,
constraints, and review instead of repeatedly supervising steps the system has
already proved it can perform safely.

## The five rungs

| Rung | What it looks like | You still control |
| --- | --- | --- |
| **1. Assisted** | The agent suggests code or answers questions while you work. | Every edit and command. |
| **2. Delegated** | You give a local agent a bounded task; it changes files and runs checks. | The task, permissions, and final review. |
| **3. Automated** | An issue, message, or schedule starts a proven workflow without your laptop. | The trigger, allowed actions, and acceptance gate. |
| **4. Governed** | A team shares pinned agent configurations, policies, identities, and evidence. | Organization policy and exceptions. |
| **5. Self-improving** | Recorded outcomes feed evaluations that propose better configurations. | The goal, evaluation criteria, and promotion decision. |

You can stop at any rung. A team with reliable delegated workflows is already
getting value; autonomy is not a requirement.

## 1. Assisted: work beside the agent

This is where most people begin. You ask an agent to explain unfamiliar code,
suggest a function, or help diagnose a test failure. You decide what to paste,
edit, and run.

At this rung, notice which instructions you repeat: repository conventions,
test commands, review rules, or a preferred way to investigate failures. Those
repeated instructions are candidates for a reusable agent configuration.

**Try this:** ask the agent to explain one failing test and suggest a fix. Make
the edit yourself and run the test.

## 2. Delegated: hand over one bounded task

Now let the agent perform a complete but small task on your machine. A good
first task has a clear finish line, such as:

- update one dependency and make its tests pass;
- add a test for a known bug;
- rename one documented option throughout a repository; or
- investigate a failure and write a report without changing code.

Before starting, tell the agent what it may change and how success will be
checked. Keep normal source control around the work so you can inspect or discard
every change.

```text
Update dependency X in this repository.
Do not change unrelated dependencies.
Run the unit tests and show me the resulting diff.
Stop before publishing or merging anything.
```

Review the diff and test output yourself. When the same kind of task works
repeatedly with clear instructions and reviewable results, it is a candidate
for automation.

[Run the Outfitter getting-started guide →](/docs/outfitter/documentation/getting-started/)

## 3. Automated: run a proven workflow without your laptop

Automation changes how work begins. Instead of you opening a terminal, an issue,
pull request, message, or schedule starts the agent. The output should still go
through an explicit gate, usually tests and human pull-request review.

Move only a workflow you already understand from the delegated rung. Before it
runs unattended, define:

- the event that is allowed to start it;
- the repository, files, and external systems it may access;
- a dedicated identity with the minimum required permissions;
- a time, cost, or iteration limit;
- the checks that must pass; and
- the person or policy that approves the result.

Use [Actions](/docs/actions/) for GitHub events and schedules today. The
[hosted issue path](/docs/cloud/) is a separate one-shot evaluation on AI
Outfitter's compute and inference; it does not deploy your configuration.

[Channels](/docs/channels/) is alpha software for waking a long-running Pi
session. [Agent Operator](/docs/agent-operator/) specifies the Kubernetes
resident path, but it is still at the design stage and is not a public
onboarding path. Treat resident execution as a target state rather than the
next quick-start step.

## 4. Governed: make the workflow a team-owned system

A few successful automations can become difficult to manage if every developer
has a different prompt, model, permission set, or copy of a skill. Governance
means the team owns these choices as reviewed configuration.

At this rung, the organization should be able to answer:

- Which agent configuration ran?
- Which version was approved?
- What identity and permissions did it use?
- What files, commands, and external systems did it touch?
- Which checks and reviews allowed the work to continue?

Store shared configurations in a catalog and pin versions. Start with the
[Outfitter catalog documentation](/docs/outfitter/documentation/catalogs/)
and the [.agents catalog](/docs/agents/). Use [Link](/docs/link/) to inspect
software-delivery signals. [Pensieve](/docs/pensieve/) is a design-stage
project for retaining durable run evidence, not an available control today.

## 5. Self-improving: learn from recorded outcomes

Only attempt improvement after you have trustworthy records and repeatable
acceptance checks. An improvement loop compares agent configurations against
real tasks or controlled evaluations. A candidate configuration is promoted
only when it performs better and still satisfies policy.

“Self-improving” does not mean letting a production agent silently rewrite its
own rules. Humans still define the goal, choose the evaluation, and approve what
is promoted. [Evals](/docs/evals/) provides the measurement layer;
[Autoimprove](/docs/autoimprove/) explores controlled skill-improvement loops.

## One example across the whole ramp

Consider dependency updates:

1. **Assisted:** the agent explains a release note while you update the package.
2. **Delegated:** the agent updates one package locally and gives you a tested diff.
3. **Automated:** a weekly workflow opens tested update pull requests.
4. **Governed:** every repository uses an approved, pinned update profile with a dedicated identity and retained evidence.
5. **Self-improving:** evaluations compare candidate update strategies, and a person approves the better profile.

The task stays recognizable at every rung. What changes is where the work
starts, how much the agent owns, and which evidence must exist before it can
continue.

## Two rules for moving forward

1. **Do not automate a workflow you have not completed manually with an agent.**
   You need to understand its normal path and failure modes first.
2. **Move one control point at a time.** Keep the next boundary human-controlled
   until the inner workflow is reliable, bounded, and reviewable.

If you are unsure where to begin, stay on the delegated rung: choose one small
task, run it locally, review everything, and save the configuration that worked.

Read the [canonical Outfitter philosophy](/docs/outfitter/philosophy/) for the
short formal definition of the ramp.
