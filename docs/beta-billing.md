# Beta prepaid billing

`https://beta.ai-outfitter.com/billing/` stages the merged prepaid purchase slice.
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
reading the user and organization memberships. GitHub writes and other APIs are
unavailable in this beta entry point. `GET /api/accounts` supplies the navigation
with the token owner and a sandbox indicator; the navigation hides unsupported
account-management actions. It does not prove OAuth, multiple-user
sessions, inference, or resident behavior.

Only sandbox Stripe keys are accepted. The signed Stripe webhook is the sole
route exempt from the beta password. All assets run through the Worker and are
private/no-store. Production billing configuration remains unchanged.

After configuring sandbox Stripe, complete a hosted test Checkout, confirm its
balance, replay the webhook, and perform partial refunds to verify reversals.
Also test personal-account denial and organization-member denial. Record payment
and event IDs, response statuses, and balance deltas; never record credentials or
card details. Missing sandbox keys leave checkout unavailable.
