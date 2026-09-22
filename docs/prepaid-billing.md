# Prepaid purchases

This slice accepts USD credit purchases for a GitHub user or organization.
It does not yet enable inference, top-ups, or residents.

- `GET /api/billing/accounts` lists the signed-in user and organizations they own.
- `GET /api/billing/:login` returns the account's paid balance in microdollars.
- `POST /api/billing/:login/checkout` accepts `{ purchaseId, cents }`. The client
  MUST retain its UUID across retries and MUST change it for a different amount.
- `POST /api/webhooks/stripe` fulfills confirmed payments and reconciles refunds
  and disputes. It MUST remain enabled when new purchases are disabled.
- `/billing/` provides account selection, balance display, and hosted Checkout.

Balances use immutable GitHub IDs. Organization ownership is checked against
GitHub on each billing request; repository write access does not grant billing
authority. No GitHub App repository installation is required for personal billing.

## Configuration and acceptance

`BILLING_ENABLED` defaults to `false` in production and preview. Supply matching
`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` secrets; set `STRIPE_LIVE_MODE`
to `true` only for a live Stripe endpoint. Keep preview on its own test account.
Configure payment_intent.succeeded, charge.refunded, charge.dispute.created,
charge.dispute.updated, and charge.dispute.closed at `/api/webhooks/stripe`.

Before opening purchases, prove a test Checkout credits the chosen account once,
replay its webhook, refund it in parts, and verify the balance. Test organization
member rejection and a different personal user's rejection. A return URL is not
payment proof. Failed reconciliation returns 503 so Stripe retries delivery.

Stripe customer creation and Checkout use stable idempotency keys. Unknown
Checkout outcomes older than 23 hours require reconciliation rather than reuse
of an expired Stripe idempotency key. Balance changes and payment identity are
committed atomically in the account's SQLite-backed Durable Object.

Run `devenv shell -- npm run test:worker` and `devenv shell -- npm run check`.
Ledger tests execute real SQLite, including rollback after a duplicate payment ID.

## Design partners

Operator configuration `PARTNER_ALLOWANCES` is a JSON mapping from stable account
IDs to monthly USD microdollars, for example `{"org:42":20000000}` for $20.
No card is required. Removing an account revokes unused promotional credit on
its next request. Grants renew on access in each UTC calendar month, never
accumulate, and amount changes apply next month. Re-enrolling a revoked account
in the same month does not issue a second grant. Paid credit is unchanged.
