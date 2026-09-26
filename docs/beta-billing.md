# Beta website and sandbox billing

`https://beta.ai-outfitter.com/` serves the full website. `/dashboard/` uses
the shared dashboard routes for repository configuration, sources, workflows,
account switching, and read-only plan previews. `/billing/` stages prepaid credit.
Deploy with `devenv shell -- node scripts/beta.mjs deploy` after running
`npm run check:precommit` and `npm exec -- wrangler deploy --env beta --dry-run`.
The beta entry point and its Durable Object namespaces are separate from production.
Neither production nor preview imports the beta entry point.

Run `devenv shell -- node scripts/beta.mjs configure` to provision beta secrets.
It reads `CLOUDFLARE_API_TOKEN`, `GH_TOKEN_RO`, and optional
`STRIPE_TEST_SECRET_KEY` from the owner `.env`. It generates a beta password,
uploads secrets only to beta, and creates the sandbox Stripe webhook when a test
key is available. Secrets are retained in ignored, mode-0600 `.beta-secrets.json`;
keep this file to preserve the password and webhook signing secret across reruns.
Never commit it or paste its contents into logs. The browser username is `beta`;
use the `BETA_ACCESS_PASSWORD` property for the password. Rotate that property
and rerun configure to revoke previous beta access.

This is a single-operator staging identity, not customer login. Every authorized
request uses the read-only token's GitHub identity. Personal ownership and active
organization-owner checks still execute against GitHub. The token must allow
reading the user and organization memberships. The dashboard also includes the
configured ai-outfitter account; repository reads still require GitHub access,
and this does not grant organization billing permission. GitHub writes, GitHub
webhooks, and OAuth endpoints are blocked. Account selection and plan previews
require the beta origin. `GET /api/accounts` supplies the normal account menu
with a sandbox indicator; OAuth sign-out and installation actions are hidden. It does not prove OAuth, multiple-user
sessions, inference, or resident behavior.

Only sandbox Stripe keys are accepted. The signed Stripe webhook is the sole
route exempt from the beta password. All assets run through the Worker and are
private/no-store. Production billing configuration remains unchanged.

After configuring sandbox Stripe, complete a hosted test Checkout, confirm its
balance, replay the webhook, and perform partial refunds to verify reversals.
Also test personal-account denial and organization-member denial. Record payment
and event IDs, response statuses, and balance deltas; never record credentials or
card details. Missing sandbox keys leave checkout unavailable.

## Continuous staging

Pushes to `beta` run the complete CI suite and deploy only the beta Worker.
Pushes to `main` deploy production; pull requests retain their isolated previews.
Deployments are serialized per branch. Worker secrets remain in Cloudflare;
CI never copies local credentials or production Stripe keys into beta.

Keep `beta` as an integration branch, never merge it wholesale into `main`.
Merge main into beta as production PRs land. To stage an unmerged PR, merge its
head branch into beta in dependency order and push beta. Record the included
PRs and the deployed commit in the staging test results. Keep each original
PR independently reviewable against its intended base. Revert an integration
merge to remove a staged slice; do not reset billing storage as a code rollback.

Stage partner allowances and usage budgets next, then CLI authorization and the
gateway; top-ups need budgets, and Spark needs the gateway. Merge the required
configuration and migrations into beta explicitly: the current beta adapter
allows dashboard and billing APIs only. CLI device authorization and gateway
acceptance require their real authentication flows, not the operator PAT.
Enabling those slices must include beta routes, required secrets, model config,
and positive/negative tests. Deploying their code alone is not acceptance.

Sandbox keys are needed for purchase/reversal/top-up acceptance. Grants and
budget tests can proceed independently. The CLI provider is tested from its
own PR build against beta after authorization and gateway are staged. Resident
triage requires the separate operator/profile deployments and GitHub event
credentials; the website beta branch does not deploy those repositories.
