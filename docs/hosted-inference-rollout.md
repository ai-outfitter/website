# Hosted inference and resident adoption rollout

Implementation record, 2026-09-22. The slices below are draft pull requests.
They are not a production launch. New capabilities default disabled.

## Review and landing order

| Slice | Pull request | Dependency |
| --- | --- | --- |
| Prepaid Stripe purchases and reversals | [website #20](https://github.com/ai-outfitter/website/pull/20) | main |
| Monthly partner allowance | [website #22](https://github.com/ai-outfitter/website/pull/22) | #20 |
| Usage reservations, settlement, and caps | [website #21](https://github.com/ai-outfitter/website/pull/21) | #22 |
| Consented automatic top-ups | [website #24](https://github.com/ai-outfitter/website/pull/24) | #21 |
| Browser-approved CLI credentials and workspace authorization | [website #23](https://github.com/ai-outfitter/website/pull/23) | land after #20; independent code diff |
| OpenRouter discovery and streaming gateway | [website #25](https://github.com/ai-outfitter/website/pull/25) | #21 + #23 |
| Native Pi provider and CLI account commands | [outfitter #422](https://github.com/ai-outfitter/outfitter/pull/422) | deployed #23 + #25 |
| CLI identity and workspace telemetry | [outfitter #423](https://github.com/ai-outfitter/outfitter/pull/423) | #422 |
| Website identity matching CLI | [website #27](https://github.com/ai-outfitter/website/pull/27) | #23 |
| Internal-only Spark adapter | [website #26](https://github.com/ai-outfitter/website/pull/26) | #25 |
| Two resident profiles and triage-only workflow | [community-profiles #103](https://github.com/ai-outfitter/community-profiles/pull/103) | main |
| Idempotent resident provisioning and readiness | [agent-operator #88](https://github.com/ai-outfitter/agent-operator/pull/88) | deployed catalog #103; website #28 |
| Verified events and scoped resident credentials | [website #28](https://github.com/ai-outfitter/website/pull/28) | #25; deployed operator #88 |
| Repository selection, names, status and owner recovery | [website #29](https://github.com/ai-outfitter/website/pull/29) | #28 |

`feat/inference-foundation` is the comparison base combining budgets and CLI
authorization for #25. It is not a separate product change to merge. Retarget
#25 after those dependencies land. Land dependent PRs bottom-up and preserve
reviewable commit boundaries. No stable or major release is authorized here.

## Replacement of the combined website PR

Keep [website #18](https://github.com/ai-outfitter/website/pull/18) and its
`feat/stripe-subscriptions` branch until this accounting has been reviewed.

| Original work | Disposition |
| --- | --- |
| Stripe customer, payment lifecycle, refunds/disputes | Replaced by prepaid ledger #20 and top-ups #24; subscription invoices are not the new balance authority. |
| Inference rating, markup, spend controls, meter export | Rating and limits replaced by #21/#25; prepaid settlement replaces subscription meter export. |
| Resident fulfillment, scoped identity, trusted issue routing | Reimplemented in focused resident provisioning/events/onboarding slices with two named agents and triage-only credentials. |
| $20 recurring resident seats, subscription reconciliation, seat pricing page | Deferred; seat subscriptions are outside this release. No production price is inferred from the old branch. |
| Enterprise auditability item, Pensieve traces, workload identity, immutable evidence callbacks | Deferred; preserve old branch and linked Pensieve/operator work. This release does not sell or promise auditability. |
| D1 migrations 0001–0008, setup scripts, OIDC Actions fulfillment | Not applied by this implementation. New account state uses SQLite Durable Objects; resident fulfillment uses an optional operator API. Retain old artifacts for the deferred subscription/auditability design. |
| Automatic implementation, branch pushes, PR creation, factory/merge governance | Deferred. First resident release stops at issue classification and a suggested plan. |

## Deployment configuration

Choose and verify configuration before enabling each capability. Do not commit
secrets, copy illustrative prices into production, or enable paid access from a
successful build alone.

Entry points are `/billing/` for prepaid credit and spending controls,
`/residents/` for resident onboarding, and `outfitter login` or Pi's
`/login outfitter` for hosted inference. Use `outfitter logout` or Pi's
`/outfitter-logout` for remote revocation; native Pi `/logout` only clears local
credentials.

- Stripe: matching test-mode key and signed webhook secret first, selected webhook
  events, then independently configured live credentials after acceptance.
- Models: public text/tool allowlist, fixed upstream provider, context/output
  limits, complete price ceilings, markup basis points and version, optional
  account overrides. No model ships selected or enabled.
- Workspaces: partner allowance by stable account ID; owner-authorized spenders;
  explicit paid cap or uncapped choice. Top-up threshold/amount requires consent.
- Identity: GitHub App email and organization-members permissions, callback URL,
  browser approval, token storage and revocation.
- Spark: explicit internal user IDs, real served model metadata, authenticated
  HTTPS endpoint reachable by the Worker. This work does not expose a private
  Tailscale endpoint or create a public fallback.
- Residents: operator endpoint/bearer, pinned image and catalog revision, API
  origin allowlist, scoped token broker, persistence and readiness readback.
  Both services must support the same monotonic enrollment generation; stale
  writes are rejected and readiness must match the requested generation.

## Acceptance sequence

1. **Internal accounts:** enable only the required test capabilities. Show
   `outfitter/<model>` in native Pi; complete browser login, restart, workspace
   change, text/tool streaming, logout and denied reuse. Test owner/member
   boundaries and removal during an active session. Verify internal Spark works
   and an external user cannot discover or guess-invoke it.
2. **Credited partners:** configure a monthly grant without a card. Demonstrate
   free-first settlement, no rollover, termination, concurrent admission,
   cap exhaustion, interrupted-stream reconciliation, and unresolved-cost holds.
3. **Payments:** complete test Checkout and signed webhook, replay delivery,
   partial refund/dispute/recovery, then consented top-ups, declines and uncertain
   outcomes. Compare actual provider cost, markup, ledger movement and balance.
   Paid launch waits for the complete payment/reconciliation chain.
4. **Telemetry:** verify the same person ID/email across website and CLI,
   correct workspace properties, account-switch/logout isolation, and no CLI
   analytics requests under each opt-out. Analytics failure must not affect a
   request's accounting or completion.
5. **Resident triage:** select a repository and names, provision/retry without
   duplicate agents or lost state, read back current readiness, deliver/replay
   one signed issue event and observe one useful triage response. Check account
   attribution, removed-installation rejection and inability to push or open PRs.

Record deployed revisions/configuration, request or delivery IDs, authoritative
ledger/readiness evidence and observed outcomes. Local tests and preview builds
do not substitute for these live checks.

## Implementation validation

The combined local website checkout passes 283 tests across 38 files, with zero
Astro diagnostics. The native Pi provider and identified telemetry pass hosted
Linux, macOS and Windows checks and packaged smoke tests. Operator validation
passes its full test suite, controller envtest, lint and five runtime tests,
including native Pi credential resolution. The profile catalog passes strict
workflow validation and deterministic exports.

Local review corrections include Stripe mode preflight, safe pending top-up
retries, UTC renewal after asynchronous waits, optional email failure handling,
expired-session revocation, provisioning generation fences, current-rollout
readiness, retry fairness, and owner revocation after uninstallation.

No live Stripe purchase/reversal, OpenRouter reconciliation, DGX connectivity,
PostHog delivery, or deployed resident issue-response result is claimed. These
remain the acceptance sequence above.
