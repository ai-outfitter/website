import { purchaseCents, type CreditLedger } from "./ledger";
import type { UsageBudget } from "./budget";
import { StripeRequestError } from "./stripe";

type Stripe = (path: string, body?: URLSearchParams, key?: string) => Promise<Record<string, any>>;
export type TopupSettings = { thresholdCents: number; amountCents: number; consent: true };
type Attempt = { id: string; created: number; cents: number; customer: string; method: string; payment?: string };
type State = {
  enabled: boolean; thresholdCents: number; amountCents: number; status: string;
  method?: string; consentAt?: number; consentBy?: string; revokedAt?: number;
  setup?: { id: string; session?: string; url?: string; created: number; actor: string; thresholdCents: number; amountCents: number };
  pending?: Attempt;
};
export function topupSettings(input: unknown): TopupSettings {
  const value = input as TopupSettings | null;
  if (!value || value.consent !== true || !Number.isSafeInteger(value.thresholdCents) || value.thresholdCents < 0 || value.thresholdCents > 100_000) throw new Error("Invalid topup consent or threshold");
  purchaseCents(value.amountCents);
  if (value.thresholdCents >= value.amountCents) throw new Error("Topup amount must exceed threshold");
  return value;
}

/** Called inside the account DO's concurrency gate. No unrecorded payment attempts. */
export class AutomaticTopups {
  constructor(private sql: SqlStorage, private stripe: Stripe, private ledger: CreditLedger, private reconcile: (workspace: string, paymentId: string) => Promise<unknown>) {
    sql.exec("CREATE TABLE IF NOT EXISTS automatic_topups (singleton INTEGER PRIMARY KEY CHECK(singleton=1), value TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS topup_consents (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, threshold INTEGER, amount INTEGER, created INTEGER NOT NULL)");
  }
  private read(): State {
    const value = this.sql.exec<{ value: string }>("SELECT value FROM automatic_topups WHERE singleton=1").toArray()[0]?.value;
    return value ? JSON.parse(value) : { enabled: false, thresholdCents: 500, amountCents: 2000, status: "disabled" };
  }
  private write(state: State) { this.sql.exec("INSERT INTO automatic_topups VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET value=excluded.value", JSON.stringify(state)); }
  status() {
    const state = this.read();
    return { enabled: state.enabled, thresholdCents: state.thresholdCents, amountCents: state.amountCents, status: state.status, consentAt: state.consentAt, pending: Boolean(state.pending) };
  }
  disable(actor: string) {
    const state = this.read(); state.enabled = false; state.revokedAt = Date.now(); state.setup = undefined;
    state.status = state.pending ? "reconciliation_required" : "disabled";
    this.write(state);
    this.sql.exec("INSERT INTO topup_consents (actor,action,created) VALUES (?,'revoke',?)", actor, Date.now());
    return this.status();
  }
  async setup(workspace: string, customer: string, actor: string, input: TopupSettings, origin: string) {
    topupSettings(input);
    await this.refreshPending(workspace, false);
    const state = this.read();
    if (state.pending) throw new Error("Pending topup needs reconciliation before changing card");
    // Repeating the same setup request reuses its durable key, never a new customer/session.
    if (!state.setup || state.setup.actor !== actor || state.setup.thresholdCents !== input.thresholdCents || state.setup.amountCents !== input.amountCents || Date.now() - state.setup.created >= 86_400_000) {
      state.setup = { id: crypto.randomUUID(), actor, thresholdCents: input.thresholdCents, amountCents: input.amountCents, created: Date.now() };
      this.sql.exec("INSERT INTO topup_consents (actor,action,threshold,amount,created) VALUES (?,'authorize',?,?,?)", actor, input.thresholdCents, input.amountCents, Date.now());
    }
    state.enabled = false; state.status = "setup_required"; this.write(state);
    if (state.setup.url) return { url: state.setup.url };
    if (Date.now() - state.setup.created > 23 * 3600_000) throw new Error("Card setup needs reconciliation");
    const result = await this.stripe("checkout/sessions", new URLSearchParams({ mode: "setup", customer, currency: "usd", "payment_method_types[0]": "card", "setup_intent_data[metadata][outfitter_workspace]": workspace,
      "setup_intent_data[metadata][outfitter_setup]": state.setup.id,
      success_url: `${origin}/billing/?topup_setup={CHECKOUT_SESSION_ID}&workspace=${encodeURIComponent(workspace)}`,
      cancel_url: `${origin}/billing/`,
    }), `topup-setup:${workspace}:${state.setup.id}`);
    const url = new URL(String(result.url));
    if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com" || typeof result.id !== "string" || !result.id.startsWith("cs_")) throw new Error("Invalid card setup destination");
    state.setup.session = result.id; state.setup.url = url.href; this.write(state);
    return { url: url.href };
  }
  async finishSetup(workspace: string, customer: string, session: string) {
    const state = this.read();
    if (!state.setup || state.setup.session !== session) throw new Error("Unknown or revoked card setup");
    const checkout = await this.stripe(`checkout/sessions/${encodeURIComponent(session)}?expand[]=setup_intent`);
    const intent = checkout.setup_intent;
    if (checkout.mode !== "setup" || checkout.status !== "complete" || checkout.customer !== customer || !intent || typeof intent !== "object" || intent.status !== "succeeded" || intent.customer !== customer || intent.metadata?.outfitter_workspace !== workspace || intent.metadata?.outfitter_setup !== state.setup.id || typeof intent.payment_method !== "string") throw new Error("Card setup is not complete");
    const method = await this.stripe(`payment_methods/${encodeURIComponent(intent.payment_method)}`);
    if (method.customer !== customer || method.type !== "card") throw new Error("Card does not belong to this account");
    state.enabled = true; state.method = intent.payment_method; state.consentAt = state.setup.created; state.consentBy = state.setup.actor;
    state.thresholdCents = state.setup.thresholdCents; state.amountCents = state.setup.amountCents;
    state.setup = undefined; state.status = "ready"; this.write(state);
    return this.status();
  }
  async maybeRefill(workspace: string, customer: string, summary: ReturnType<UsageBudget["summary"]>, maximumMicros: number, featureEnabled: boolean) {
    const state = this.read();
    const paidNeeded = Math.max(0, maximumMicros - summary.promotionalMicros);
    const remaining = summary.paidLimitMicros === null ? Infinity : summary.paidLimitMicros - summary.paidUsedMicros - summary.paidReservedMicros;
    const eligible = featureEnabled && state.enabled && Boolean(state.method) && summary.paidEnabled && paidNeeded > 0 && summary.paidMicros >= 0 && remaining >= paidNeeded;
    if (state.pending) { await this.refreshPending(workspace, eligible); return; }
    if (!eligible || summary.paidMicros + state.amountCents * 10_000 < paidNeeded) return;
    if (summary.paidMicros >= state.thresholdCents * 10_000 && summary.paidMicros >= paidNeeded) return;
    const attempt: Attempt = { id: crypto.randomUUID(), created: Date.now(), cents: state.amountCents, customer, method: state.method! };
    this.ledger.begin(attempt.id, attempt.cents, customer);
    state.pending = attempt; state.status = "pending"; this.write(state);
    await this.refreshPending(workspace, true);
  }
  async refreshPending(workspace: string, allowSubmit: boolean) {
    const state = this.read(); const pending = state.pending;
    if (!pending) return;
    let payment: Record<string, any> | undefined;
    try {
      if (pending.payment) payment = await this.stripe(`payment_intents/${encodeURIComponent(pending.payment)}`);
      else if (allowSubmit && state.enabled && Date.now() - pending.created < 23 * 3600_000) {
        try {
          payment = await this.stripe("payment_intents", new URLSearchParams({ amount: String(pending.cents), currency: "usd", customer: pending.customer, payment_method: pending.method, off_session: "true", confirm: "true", "payment_method_types[0]": "card", "metadata[outfitter_workspace]": workspace, "metadata[outfitter_purchase]": pending.id }), `topup:${workspace}:${pending.id}`);
        } catch (error) {
          if (error instanceof StripeRequestError && error.paymentIntentId) {
            pending.payment = error.paymentIntentId; this.write(state);
            payment = await this.stripe(`payment_intents/${encodeURIComponent(pending.payment)}`);
          } else throw error;
        }
      } else {
        // Read-only recovery survives revoked consent and Stripe idempotency retention expiry.
        let after = "";
        const deadline = Date.now() + 5_000;
        for (let page = 0; page < 10 && Date.now() < deadline; page++) {
          const result = await this.stripe(`payment_intents?customer=${encodeURIComponent(pending.customer)}&limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`);
          if (!Array.isArray(result.data)) throw new Error("Payment reconciliation unavailable");
          payment = result.data.find((item: Record<string, any>) => item.metadata?.outfitter_purchase === pending.id);
          if (payment || !result.has_more || !result.data.length) break;
          after = String(result.data.at(-1).id);
        }
      }
      if (!payment) { state.status = "reconciliation_required"; this.write(state); return; }
      if (typeof payment.id !== "string" || !payment.id.startsWith("pi_") || payment.customer !== pending.customer || payment.currency !== "usd" || payment.amount !== pending.cents || payment.metadata?.outfitter_workspace !== workspace || payment.metadata?.outfitter_purchase !== pending.id) throw new Error("Topup payment mismatch");
      pending.payment = payment.id; this.write(state);
      if (payment.status === "succeeded") {
        await this.reconcile(workspace, payment.id);
        state.pending = undefined; state.status = state.enabled ? "ready" : "disabled";
      } else if (["requires_action", "requires_payment_method", "canceled"].includes(payment.status)) {
        const status = payment.status;
        // Cancel unsuccessful intents before permitting a replacement card/charge.
        if (status !== "canceled") {
          const canceled = await this.stripe(`payment_intents/${encodeURIComponent(payment.id)}/cancel`, new URLSearchParams(), `topup-cancel:${workspace}:${pending.id}`);
          if (canceled.status !== "canceled") throw new Error("Payment cancellation unresolved");
        }
        state.enabled = false; state.pending = undefined;
        state.status = status === "requires_action" ? "authentication_required" : "payment_failed";
      } else state.status = "pending";
      this.write(state);
    } catch { state.status = "reconciliation_required"; this.write(state); }
  }
}
