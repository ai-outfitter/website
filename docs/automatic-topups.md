# Automatic prepaid credit purchases

This slice is disabled by `TOPUPS_ENABLED=false`. It requires the prepaid
purchase ledger and usage-budget slices. It does not enable payments publicly.

An owner chooses a threshold and purchase amount, explicitly consents to storing
a card and future off-session charges, and completes Stripe Checkout in setup
mode. The billing page then requires an authenticated confirmation. The server
fetches the complete SetupIntent and checks workspace, setup ID, customer, and
attached card. A return URL is never evidence of successful setup. Consent
records preserve actor, timestamp, threshold, amount, and later revocation.

The threshold is $0–$999.99; each purchase is $5–$1,000 and must exceed the
threshold. Values are whole cents; the ledger remains integer USD microdollars.
Changing amount, threshold, or card repeats the explicit consent/setup flow.

## API

All endpoints are `/api/billing/:githubLogin/topups` plus the suffix below.
Existing browser authentication and personal/org-owner authorization apply.
Every mutation requires the site's exact Origin.

- `GET`: current state, threshold, amount, pending status, feature availability.
- `POST /setup`: `{thresholdCents, amountCents, consent:true}` returns a hosted
  Stripe setup URL. Requires both billing and topup flags enabled.
- `POST /confirm`: `{session:"cs_..."}` verifies setup and enables purchases.
- `DELETE`: revoke consent for future charges and invalidate unfinished setup.
  Already-submitted charges may complete; confirmed credit remains available.
- `POST /reconcile`: read-only Stripe lookup of an unresolved attempt. Does not
  submit or confirm a charge. Available after either feature flag is disabled.

Read-only billing views and revocation remain available when new purchases are
closed. The recovery UI offers payment-status refresh, a new card setup, and the
existing manual credit purchase path. Declined/authentication-required payments
pause automatic purchases; their intents are canceled before replacement setup.
If cancel cannot be confirmed, the pending attempt continues blocking replacement.

## Admission and reconciliation

`BillingAccount.reserve(workspace,input)` keeps its existing arguments and
result but is asynchronous. Its account concurrency gate serializes payments
with reservations. It may refill on insufficient credit or after an admitted paid
request drops below the threshold. Paid usage must be enabled, current-month
usage capacity must remain, and no automatic purchase funds reversal debt or a
request too large for one configured topup. Free-only requests do not charge.
Monthly caps constrain consumed inference, not the purchase amount.

Each attempt and its ledger purchase are recorded before contacting Stripe.
Retries use the same idempotency key for at most 23 hours. Credit is created only
through the existing successful-payment reconciliation path; refunds, disputes,
and duplicate webhooks use that same ledger. Unknown and processing outcomes
remain pending and prevent replacement charges.

After 23 hours, or after consent revocation, reconciliation only lists existing
customer payments (up to 1,000 within an 5-second lookup budget) and matches immutable purchase metadata. It never
replays a potentially expired idempotency key. If the result cannot be established,
the account stays blocked for operator reconciliation. No automatic background
job initiates charges: authenticated paid inference triggers purchases; webhooks
and the owner's Check pending payment button reconcile them.

## Validation and launch acceptance

Tests use actual SQLite, fake Stripe, and a mocked Durable Object host. They
cover consent, cross-account setup, duplicate reservations/webhooks, cap limits,
feature disablement, lost responses, retained idempotency keys, expired retry
windows, revocation, declined cards, authentication-required cards, and pending
payment recovery. Live Stripe test-mode card/3DS flows, webhook delivery, and
Cloudflare runtime execution must pass before enabling for internal accounts.

References: [Stripe card setup](https://docs.stripe.com/payments/save-and-reuse-cards-only)
and [PaymentIntent creation](https://docs.stripe.com/api/payment_intents/create).
