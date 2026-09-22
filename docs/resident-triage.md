# Hosted resident issue triage (disabled by default)

This slice connects owner enrollment to the operator's two-resident API. It does
not enable software factory mode, implementation, commit pushes, or PR creation.

## Configuration

`RESIDENTS_ENABLED` defaults to `false` in production and preview. Before enabling,
configure these server-only secrets:

- `RESIDENT_OPERATOR_URL`: HTTPS origin of the operator's optional resident API.
- `RESIDENT_OPERATOR_TOKEN`: bearer shared with that API; never a browser token.
- `RESIDENT_CREDENTIAL_SECRET`: 32 random bytes encoded as base64/base64url, used to
  authenticate workspace/role credentials. Rotation revokes all existing resident
  credentials; re-enroll affected workspaces to refresh the Kubernetes secrets.

The existing GitHub App private key and webhook secret remain server-side. Its
installation must grant contents read, issues write, and metadata read, and must
subscribe to issue events. Organization owner validation needs membership access.
The operator must have its approved catalog revision, image, resource quotas and
HTTPS service-host allowlist configured independently. The browser cannot set
those values. Inference additionally requires the hosted gateway and account
credit/spending policy to be enabled.

## Owner API

- `GET /api/residents/{login}` returns owner-authorized installation/repository
  choices plus independent operator readiness. Stale or pending provisioning is
  not reported ready. Neither role tokens nor operator diagnostics are returned.
- `PUT /api/residents/{login}` accepts `repository_ids`, `projectManagerName`, and
  `engineerName`. Requires the authenticated account/org owner and same-origin
  request. Repository IDs and installation ownership are checked against GitHub.
- `DELETE /api/residents/{login}` stops new triage and revokes role credentials.
  Owner revocation remains available while the feature is closed or installation
  access is lost; it does not depend on installation discovery.
  Persistent operator resources remain available for subsequent re-enrollment.
  Already minted GitHub installation tokens remain valid until their normal expiry
  or GitHub-side revocation; disabling blocks fresh tokens immediately.

Names are display strings only; the operator derives resource identities from the
stable numeric workspace and role. Exact enrollment retries retain identity and
credentials. Re-enabling rotates credentials. Provisioning retries are durable
and serialized. Each changed enrollment has a monotonic generation; the operator
fences every resource mutation by that generation. Independent status must report
the same generation before the website reports readiness. Credential-key or service
origin changes also advance the generation on re-enrollment.

## Resident access

Role tokens are HMAC-bound to one workspace, role and credential generation. They
may authenticate hosted inference as `resident:<workspace>:<role>`; these are
nonhuman identities and do not inherit a person's Spark entitlement. Account
budget admission remains authoritative. Current installation access is rechecked.

`POST /api/residents/github-token` accepts a role bearer and `{repository_id}`.
It verifies current enrollment, installation owner, and repository identity, then
mints one repository's token with only `contents:read`, `issues:write`, and
`metadata:read`. Tokens are never sent to browsers or logged. The operator's `gh`
wrapper calls this broker for each invocation.

## Event delivery

The existing GitHub webhook verifies the raw-body HMAC before tenant lookup. Only
`issues.opened` enters resident triage. Selected repositories with enrollment are
consumed by this route even when disabled, suspended, or sent labeling/comment
triggers; they do not fall through to the legacy software-factory handler.

The stable task ID is `triage:<workspace>:<repository-id>:<issue-number>`. A durable
outbox keeps the first task payload, filters workflow-control labels, and retries
with that exact ID and payload. A persisted round-robin cursor prevents unavailable
earlier tasks from starving later ones. Every attempt revalidates the live installation and
repository. A changed enrollment revision cancels its earlier pending tasks,
including disable/re-enable and installation replacement. The operator sends only to the manager; Channels'
principal/message-ID deduplication completes the retry boundary. The issue body is
untrusted data fetched by the triage workflow, never control instructions embedded
in the webhook message. The engineer is provisioned but idle.

## Acceptance before enabling

Test a fresh owner enrollment and independent generation-bound readiness, a real
new issue receiving one classification/suggested-plan response, redelivery without
a second task, exact workspace usage attribution, and no branch or PR creation.
Verify member/non-owner rejection, a different repository's credential denial,
revocation, GitHub installation suspension, and operator outage recovery. Local
unit tests and a ready Pod alone are not live end-to-end acceptance.
