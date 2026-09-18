# Resident billing and fulfillment contract

## Product contract

AI Outfitter sells one resident agent for `$20/month`. The resident itself
starts with the `issue-triage` workflow and owns classification; this is not an
Actions runner that only assigns later work to a resident. Inference is billed
in arrears as two separate amounts:

1. provider cost, passed through without a discount; and
2. AI Outfitter markup, calculated from the same immutable usage record.

A promotion code may waive the markup. It must never discount the resident fee
or provider cost. The initial customer is Unsupervisedcom. The same contracts
must work for later GitHub organizations without customer-specific branches in
the website.

Enterprise auditability is an optional fourth recurring line item. Its amount
is an explicit product-owner input when the Stripe catalog is configured; it is
not derived from browser input or silently bundled into the resident fee. The
line entitles exactly one resident to the versioned
`resident-complete-trace-v1` Pensieve profile. That profile retains the complete
session content Pi exposes: user prompts, system prompt/options, assistant
messages including exposed thinking blocks, model request metadata, tool intent,
tool results, and terminal output. It does not promise hidden provider chain of
thought that the model API never supplies.

The `$200/month` fleet offer is not available for checkout until resident
quantity, concurrency, and support entitlements have explicit contracts.

## Identities and boundaries

The billing tenant is the GitHub organization selected by an authenticated
user. The server must verify both that the GitHub App installation is visible
and that the user currently has organization-administrator authority. It is not
the reusable GitHub persona login used by a resident. A purchaser is recorded
as `created_by`; current billing administrators are derived from current GitHub
authority rather than permanent ownership by that purchaser.

Each paid tenant has a distinct Agent resource, credential set, notification
organization filter, inference credential, and Stripe customer. A persona
login such as `luce-unsup` can be reused, but its credentials cannot be shared
between tenants.

The public website Worker does not receive Kubernetes credentials. It writes a
durable provisioning operation and enqueues durable work. Customer one can be
fulfilled by a reviewed catalog change and the existing cluster deployment
workflow. A workload-identity-authenticated credential broker or ExternalSecret
owner creates, rotates, and revokes the per-tenant GitHub and inference
credentials referenced by that catalog. The deploy action cannot read or create
the Secret material.

A resident is not reported active until an OIDC-authenticated fulfillment
callback supplies the operation ID, catalog commit, workflow run, cluster,
Agent UID and name, metadata generation, observed generation, pinned catalog
revision, and Ready condition. Callback subject, audience, repository, ref, and
workflow are allowlisted; the operation ID and observed generation make replay
idempotent. The cluster reconciler is authoritative for deployment state.

## Durable records

The website owns these records in D1:

- `billing_accounts`: tenant key, GitHub account identity and installation,
  Stripe customer, creator, current authorization state, markup policy, monthly
  spend budget, and a future alert threshold.
- `subscriptions`: Stripe subscription and item identities, lifecycle status,
  billing period, resident quantity, and the separately verified auditability
  item identity.
- `entitlements`: the derived permission to provision, wake, run, and audit a
  resident.
- `residents`: tenant-specific Agent resource identity, starting workflow, and
  desired and observed deployment state, including the versioned Pensieve
  profile and deployment evidence.
- `provisioning_operations`: idempotent desired revisions, attempts, evidence,
  errors, and approval state.
- `stripe_events`: raw event identity and processing outcome for replay and
  out-of-order handling.
- `inference_usage_events`: immutable, service-authenticated usage with tenant,
  resident, request identifier, provider, model, token counts, rate-card
  version, provider-cost micros, markup basis points, markup micros, and time.
- `meter_exports`: usage event and Stripe meter-event identifiers with retry
  and reconciliation state.

Money calculations use integer micros. Stripe meter values use whole integer
micro-dollar units. Stripe is an invoice processor, not the canonical usage
ledger. Uniqueness constraints enforce one Stripe customer per tenant, at most
one active resident subscription per tenant and product, one resident ordinal,
one provisioning operation per desired revision, one usage request per
tenant/resident/body digest, and one export per usage event and meter.

## Checkout and fulfillment

1. The user signs in with GitHub and selects an organization installation. The
   server rechecks installation visibility and organization-administrator
   authority at checkout and at every destructive billing operation.
2. `POST /api/billing/checkout` ignores caller-supplied customer and price IDs,
   creates or reuses the tenant Stripe customer, and creates a subscription
   Checkout Session containing the resident, provider-cost meter, and markup
   meter items, plus the configured enterprise-auditability item when selected.
   The success URL contains `{CHECKOUT_SESSION_ID}` only for status display; it
   is not a fulfillment signal.
3. Checkout allows only configured promotion IDs. The no-markup promotion maps
   to a `100%` forever coupon restricted to the markup Product, with explicit
   customer, first-use, expiry, and redemption limits. The webhook verifies the
   applied discount references that coupon. No other promotion can silently
   alter the resident or provider-cost lines.
4. `POST /api/webhooks/stripe` verifies the signature over the unmodified body,
   stores every Stripe event ID once, retrieves the authoritative current
   Stripe objects, validates customer, product, and tenant metadata, and derives
   subscription state. Arrival order never directly sets entitlement state. A
   scheduled reconciliation compares Stripe and D1 and repairs missed events.
5. A paid, active subscription creates one idempotent resident provisioning
   operation with starting workflow `issue-triage`.
6. A Queue or Cloudflare Workflow consumer advances the operation through
   credential approval, reviewed catalog change, deployment, and callback. It
   retries idempotently and exposes a dead-letter/reconciliation state. The
   reviewed catalog path creates the tenant Organization and Agent references;
   the credential owner separately creates tenant-scoped Secret material.
   Authenticated deployment evidence moves the resident to active.
7. GitHub issue wakes and inference requests require an active entitlement and
   the matching tenant and resident identity.
8. Entitlement drives a required Agent `spec.suspended` control: suspension
   scales runtime to zero while preserving its PVC and reports a Suspended
   condition. The same transition revokes the inference credential. The
   operator must implement this before non-test payment is accepted.
9. An auditability entitlement also drives a required, tenant-scoped Pensieve
   collector configuration and projected workload token. Fulfillment cannot
   report the resident Ready until the callback proves the exact collector
   revision/profile, OIDC subject, sink identity, and a read-back trace probe.
   A browser-supplied flag or a successful token upload is not that proof.

Checkout completion without an active resident is displayed as provisioning,
not success. Webhook receipt without deployment evidence is also provisioning.

### Payment lifecycle

| Authoritative Stripe state | Entitlement desired state |
| --- | --- |
| active or trialing, latest required invoice paid | active |
| past_due within the published grace interval | active, with warning and no spend-limit increase |
| past_due after grace, unpaid, or paused | suspended |
| cancel_at_period_end before paid-through time | active until the paid-through boundary |
| canceled or refunded through the current period | suspended at Stripe's effective time |
| disputed | suspended pending a billing-administrator decision |
| paid recovery after suspension | active and idempotently resumed |

Every transition stores its Stripe effective timestamp. A stale event cannot
regress a newer derived state.

## Inference accounting

Checkout records the accepted markup basis points, supported provider/model
rate-card version, currency and tax treatment, monthly spend budget, future
alert threshold, and behavior at the budget. The inference gateway rejects new
work after recorded usage reaches the budget; already-authorized in-flight work
can settle above it. The dashboard shows accrued rated cost.

The trusted inference gateway records one immutable usage event per completed
provider request. In one atomic D1 transaction it inserts the usage record and
both meter-export intents before returning the provider result to the resident.
The event captures the provider response usage and a versioned rate-card
snapshot. The first release supports only explicitly listed text-model input,
output, and cache dimensions; tools, images, batch adjustments, or other fees
are rejected until they have a rate contract. It computes:

```text
provider_cost_micros = rated input + rated output + rated cache usage
markup_micros = round(provider_cost_micros * markup_basis_points / 10_000)
```

The gateway never accepts cost, tokens, customer, or discount policy from a
browser or resident payload. Resident credentials identify the tenant and
resident server-side. A caller idempotency key is namespaced by tenant and
resident and bound to a request-body digest; reuse with different content is
rejected.

Every recorded event exports both provider-cost and markup meter values, even
when a customer has the no-markup promotion. Stripe applies the discount only
to the markup Product, preserving the undiscounted ledger and invoice evidence.
The product language calls the first line `rated provider cost`: provider-token
usage times the published rate card is not proof of the provider's eventual
invoice. Provider invoice adjustments require separate reconciliation entries.

The D1 outbox is unique on `(usage_event_id, meter_id)`. Stripe identifiers are
only a short-window duplicate defense. An exporter records each response before
marking delivery, retries ambiguous requests only inside Stripe's supported
deduplication window, and sends exports before Stripe's event-age cutoff. Late
or irrecoverably ambiguous usage is held for an explicit invoice adjustment;
it is never silently resent. Reconciliation polls asynchronous meter summaries.

## Customer-one fulfillment

Unsupervisedcom is the first tenant. Its subscription selects the actual GitHub
App installation at checkout; the organization slug is not hard-coded from a
display name. The provisioning operation produces a reviewed catalog change
for a tenant-specific resident. The resident may use the `luce-unsup` persona,
but receives Unsupervisedcom-scoped GitHub credentials and notification filters.

Before payment is accepted outside Stripe test mode, the tenant catalog entry,
credential references, deploy action, entitlement gate, inference credential,
credential broker, authenticated deployment callback, usage ingestion, spend
limit, and suspension path must exist. Manual approval of the first catalog
change is acceptable. Manual creation of billing state, manual usage entry, or
declaring a resident active without deployment evidence is not.

## End-to-end acceptance

Run this acceptance in Stripe test mode against an isolated tenant installation:

1. Sign in as a GitHub administrator and select the Unsupervisedcom installation.
2. Start the `$20/month` resident checkout, select enterprise auditability, and
   redeem the no-markup promotion. Prove the auditability Product appears as a
   separate, configured recurring invoice line.
3. Complete payment and deliver the signed Stripe events, including a duplicate
   and an intentionally delayed earlier lifecycle event.
4. Observe one active subscription, one entitlement, and exactly one
   provisioning operation for the selected tenant.
5. Approve the tenant credential request, prove its Secret material is distinct
   from every other tenant, and deploy the generated catalog change. Observe an
   authenticated callback for the exact Agent generation Ready with the
   resident-owned `issue-triage` workflow.
6. Open a test issue. Observe one idempotent wake routed to that resident, the
   resident applying exactly one repository-defined classification, and a
   completed triage result.
7. Read the session back from Pensieve as the tenant-authorized auditor. Prove
   it contains the prompt, system options, complete Pi-visible assistant message
   (including an exposed thinking block), model request metadata, tool call
   intent, tool result, and terminal output, all bound to the resident and one
   session. Prove a different tenant cannot write or read that evidence.
8. Run one deterministic metered inference request. Re-send its usage event and
   prove only one immutable ledger record and one export per meter exist.
9. Poll until Stripe's asynchronous meter summaries include both events. Preview
   the invoice and prove the resident, enterprise-auditability, and
   rated-provider-cost lines are unchanged while the gross markup is present
   and discounted to zero.
10. Reach the configured monthly budget and prove new inference fails closed;
   separately verify that any already-authorized in-flight usage is still recorded.
11. Mark the subscription unpaid beyond grace and prove the Agent reports
    Suspended, new issue wakes and inference are denied, its credential is
    revoked, and billing and deployment evidence remain auditable. Pay the
    invoice and prove one idempotent resume.

Passing unit tests or completing Checkout alone does not satisfy this
acceptance. The test must retain Stripe object IDs, tenant identity, Agent
resource evidence, issue URL, usage-event identity, and invoice preview.
