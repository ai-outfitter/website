# Internal Spark on beta

This slice implements website issue #32. Only the beta Worker imports these routes.
The existing dashboard and sandbox billing remain available. Production bindings
and behavior are unchanged.

- `/internal/authorize`: browser-approved CLI device login via GitHub.
- `/internal/inference`: signed-in browser smoke test.
- `/api/cli/device`, `/api/cli/token`, `/api/cli/me`, `/api/cli/logout`: shared Pi/CLI lifecycle; see internal-auth.md.
- `/v1/models` and `/v1/chat/completions`: internal-user session or Bearer authorization.

The shared beta Basic password and dashboard PAT never authorize these APIs.
`INTERNAL_USERS` is a list of stable `github:<id>` identities, checked on each
request. Initially only the operator is allowed. Set `INTERNAL_INFERENCE_ENABLED`
to false to stop discovery/inference and new logins; logout remains available.

## Configuration

Configure the GitHub app callback URL
`https://beta.ai-outfitter.com/api/auth/callback/github`. Set
`BETA_GITHUB_CLIENT_SECRET` in the owner .env; `scripts/beta.mjs configure` uploads
it to beta as `GITHUB_CLIENT_SECRET`. The script maintains separate beta auth and
GitHub grant encryption secrets. Do not regenerate these while sessions exist.

The beta Worker holds `SPARK_AUTHORIZATION` and `SPARK_BASE_URL` as Cloudflare
secrets. The authorization value is the full upstream header (the current Spark
gateway uses Basic auth). Never send it to the CLI or browser. Use the existing
private beta secret file or owner environment with the configure script; do not
commit credentials. `SPARK_MODEL` identifies the upstream model. The one public
model ID for this slice is `spark/glm-5.3-flash`; there is no fallback upstream.

Requests are capped at 256 KiB and 4,096 output tokens. One shared Durable Object
enforces four global/two per-user concurrent requests and twenty requests per
user per minute. Leases expire after185 seconds; requests abort after180 seconds.
Completed, failed, or cancelled streams release their leases. Prompts and tokens
are not logged. No billing balance or reservation is used.

## Acceptance

Use a normally packaged CLI with the user-home setting
`experimental.outfitter_provider: true`; no separate CLI beta package or env flag.
Verify browser approval, Pi discovery, streaming and a tool-call round trip,
restart persistence, refresh, logout/revocation, removed-user denial, anonymous
and guessed-model denial, and default-off behavior. Record website commit and
CLI package revision. Do not treat unit tests or deployment as this live proof.
