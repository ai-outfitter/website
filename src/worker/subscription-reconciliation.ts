import { BillingStore, type SubscriptionReconciliationCandidate } from "./billing-store";
import { handleStripeWebhook } from "./billing-webhook";
import { stripeSignature } from "./stripe-webhook";

const RECONCILIATION_BATCH_SIZE = 25;
const SUCCESS_INTERVAL_MS = 15 * 60 * 1_000;
const RETRY_BASE_MS = 5 * 60 * 1_000;
const RETRY_MAX_MS = 60 * 60 * 1_000;

type ReconciliationStore = Pick<BillingStore,
  "listSubscriptionReconciliationCandidates" | "recordSubscriptionReconciliationAttempt"
  | "getBillingAccountByStripeCustomer" | "getAccountStatus"
  | "applySubscriptionEvent" | "applyBillingReviewEvent" | "releaseBillingReviewHold">;

function retryDelay(failureCount: number) {
  const exponent = Math.min(Math.max(failureCount, 0), 4);
  return Math.min(RETRY_BASE_MS * (2 ** exponent), RETRY_MAX_MS);
}

function reconciliationEvent(candidate: SubscriptionReconciliationCandidate, now: number, livemode: boolean) {
  const created = Math.floor(now / 1_000);
  return JSON.stringify({
    id: `evt_reconcile_${candidate.stripeSubscriptionId}_${now}`,
    type: "customer.subscription.updated",
    created,
    livemode,
    data: { object: { id: candidate.stripeSubscriptionId } },
  });
}

async function reconcileCandidate(
  env: Env,
  store: ReconciliationStore,
  candidate: SubscriptionReconciliationCandidate,
  now: number,
  stripeFetch: typeof fetch | undefined,
) {
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  if (!webhookSecret || !secretKey) throw new Error("Stripe reconciliation is not configured");
  const rawBody = reconciliationEvent(candidate, now, secretKey.startsWith("sk_live_"));
  const timestamp = Math.floor(now / 1_000);
  const signature = await stripeSignature(webhookSecret, timestamp, rawBody);
  const guardedStore = {
    getBillingAccountByStripeCustomer: store.getBillingAccountByStripeCustomer.bind(store),
    getAccountStatus: store.getAccountStatus.bind(store),
    applyBillingReviewEvent: store.applyBillingReviewEvent.bind(store),
    releaseBillingReviewHold: store.releaseBillingReviewHold.bind(store),
    applySubscriptionEvent: (event: Parameters<ReconciliationStore["applySubscriptionEvent"]>[0]) => {
      if (event.billingAccountId !== candidate.billingAccountId
        || event.stripeSubscriptionId !== candidate.stripeSubscriptionId) {
        throw new Error("Stripe subscription does not match the scheduled tenant binding");
      }
      return store.applySubscriptionEvent(event);
    },
  };
  const response = await handleStripeWebhook(new Request("https://ai-outfitter.com/api/webhooks/stripe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${signature}`,
    },
    body: rawBody,
  }), env, { store: guardedStore, stripeFetch, now });
  if (!response.ok) throw new Error(`Stripe subscription reconciliation returned HTTP ${response.status}`);
}

export async function reconcileStripeSubscriptions(
  env: Env,
  dependencies: {
    store?: ReconciliationStore;
    reconcile?: (candidate: SubscriptionReconciliationCandidate) => Promise<void>;
    stripeFetch?: typeof fetch;
    now?: number;
    limit?: number;
  } = {},
) {
  const now = dependencies.now ?? Date.now();
  const store = dependencies.store ?? new BillingStore(env.BILLING_DB);
  const candidates = await store.listSubscriptionReconciliationCandidates(
    now,
    dependencies.limit ?? RECONCILIATION_BATCH_SIZE,
  );
  let reconciled = 0;
  let failed = 0;

  for (const candidate of candidates) {
    try {
      if (dependencies.reconcile) await dependencies.reconcile(candidate);
      else await reconcileCandidate(env, store, candidate, now, dependencies.stripeFetch);
      const recorded = await store.recordSubscriptionReconciliationAttempt({
        stripeSubscriptionId: candidate.stripeSubscriptionId,
        billingAccountId: candidate.billingAccountId,
        succeeded: true,
        nextAttemptAt: now + SUCCESS_INTERVAL_MS,
        now,
      });
      if (!recorded) throw new Error("Subscription reconciliation result could not be persisted");
      reconciled += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : "Unexpected error";
      try {
        const recorded = await store.recordSubscriptionReconciliationAttempt({
          stripeSubscriptionId: candidate.stripeSubscriptionId,
          billingAccountId: candidate.billingAccountId,
          succeeded: false,
          nextAttemptAt: now + retryDelay(candidate.reconciliationFailureCount),
          error: message,
          now,
        });
        if (!recorded) throw new Error("Subscription reconciliation failure could not be persisted");
      } catch (recordError) {
        console.error(JSON.stringify({
          message: "Stripe subscription reconciliation failure could not be persisted",
          billingAccountId: candidate.billingAccountId,
          githubAccountId: candidate.githubAccountId,
          stripeSubscriptionId: candidate.stripeSubscriptionId,
          error: recordError instanceof Error ? recordError.message : "Unexpected error",
        }));
      }
      console.error(JSON.stringify({
        message: "Stripe subscription reconciliation failed",
        billingAccountId: candidate.billingAccountId,
        githubAccountId: candidate.githubAccountId,
        stripeSubscriptionId: candidate.stripeSubscriptionId,
        error: message,
      }));
    }
  }
  return { scanned: candidates.length, reconciled, failed };
}
