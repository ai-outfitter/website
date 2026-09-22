# CLI authorization (feature gated)

`CLI_AUTH_ENABLED` defaults to `false` in production and preview. Deploying this
slice creates the `CliDevice` SQLite Durable Object binding and migration; it
does not enable sign-in or inference. Inference and billing are separate slices.

The GitHub App requires user email read permission and organization members read
permission. Existing installations may need to accept changed permissions.
Missing email permission does not block personal sign-in. Missing organization
membership permission prevents organization spending.

## Client contract

- `POST /api/cli/device` returns `device_code`, `user_code`, `verification_uri`,
  `expires_in: 600`, and `interval: 5`. Show the code and open the verification
  page. The page requires GitHub sign-in followed by explicit approval or denial.
- `POST /api/cli/token` accepts the device grant type
  `urn:ietf:params:oauth:grant-type:device_code` and `device_code`. Respect
  `authorization_pending`, `slow_down` (increase polling interval by five
  seconds), `access_denied`, and `expired_token`. A code can be exchanged once.
- The same endpoint accepts `grant_type: "refresh_token"` and `refresh_token`.
  Access tokens expire in 15 minutes. Refresh rotates both credentials; retain
  the new pair atomically. Refresh lifetime is 30 days from initial approval.
  Replaying an old refresh token fails. A lost refresh response requires login.
- `GET /api/cli/me` requires a Bearer token and returns `{user, workspace,
  workspaces}`. User IDs are `github:<numeric ID>`; workspace IDs are
  `user:<numeric ID>` or `org:<numeric ID>`. Login begins in the personal workspace.
- `PUT /api/cli/workspace` accepts `{workspace_id}` and returns the same context.
  Organization access loss returns 403; changing explicitly to personal remains
  possible. There is no automatic payer fallback.
- `POST /api/cli/logout` revokes the device's access and refresh credentials.
  The last issued access token can revoke even after access expiry. Logout
  remains available while the feature is disabled, without current organization
  access or an available GitHub API.

The gateway imports `authenticateCli(request, env)` from `worker/cli-auth`. It
returns authenticated user and selected workspace context, rechecking GitHub
identity and organization membership each request. Authorization failures throw
an HTTP Response; upstream failures must be handled as unavailable. No GitHub or
upstream inference credentials are returned to the client.

## Organization authorization and email

Owners manage a complete list of authorized GitHub user IDs through
`GET /api/cli/organizations/:numericOrgId/spenders` and
`PUT /api/cli/organizations/:numericOrgId/spenders` with
`{user_ids: ["github:123"]}`. Both require the existing browser session and live
active GitHub owner membership. PUT additionally requires the site's exact
Origin. The list is limited to 100 IDs in this slice. Owners qualify automatically;
other spenders must be both on the list and active organization members. There
is no owner-management UI in this slice.

Verified primary GitHub email is preferred, then another verified GitHub email.
If absent, the user can enter an optional account email on the approval page.
`PUT /api/cli/email` saves it using the authenticated browser session and exact
Origin. This fallback is self-reported, not a verified contact address; it must
not be used for recovery or authorization. Email may be absent from `/me`.

## Security and acceptance

Device secrets and access/refresh tokens have 256 random bits and only SHA-256
digests are persisted. Approval codes have 80 random bits, expire after ten
minutes, and cannot be approved twice. Expired devices are removed by alarms.
Approval never happens on GET, requires an authenticated same-origin POST, and
uses a page CSP that prohibits framing. Unauthenticated device/approval/token
routes share a 20 requests/minute/IP limiter (IP is hashed, not persisted raw).

Automated tests exercise the actual SQLite state transitions with a local SQLite
engine and mocked Cloudflare host, plus HTTP/GitHub authorization boundaries.
Live browser/GitHub round-trip and deployed Cloudflare execution remain rollout
acceptance checks. Before enabling, verify GitHub callback configuration, required
permissions, sign-in/approval, model requests, refresh after restart, and logout
against an internal account. This slice does not send analytics; the CLI must
apply telemetry consent before identifying this account.
