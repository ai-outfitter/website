import { AutomaticTopups, type TopupSettings } from "./topups";
import { UsageBudget, type ReserveInput } from "./budget";
import { PartnerCredit, partnerAllowance } from "./partner-credit";
import { DurableObject } from "cloudflare:workers";
import { CreditLedger, purchaseCents } from "./ledger";
import { stripeRequest } from "./stripe";

/** One object per stable GitHub account ID. Never keyed by a mutable login. */
export class BillingAccount extends DurableObject<Env> {
  private ledger: CreditLedger;
  private partner: PartnerCredit;
  private budget: UsageBudget;
  private topups: AutomaticTopups;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.partner = new PartnerCredit(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
    this.ledger = new CreditLedger(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
    this.budget = new UsageBudget(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
    this.topups = new AutomaticTopups(ctx.storage.sql, (path, body, key) => stripeRequest(this.env.STRIPE_SECRET_KEY ?? "", path, body, key), this.ledger, (workspace, payment) => this.reconcilePayment(workspace, payment));
  }

  balance(workspace: string) {
    const promotionalMicros = this.partner.renew(partnerAllowance(this.env.PARTNER_ALLOWANCES, workspace));
    return { ...this.ledger.balance(), promotionalMicros };
  }

  usage(workspace: string) {
    this.partner.renew(partnerAllowance(this.env.PARTNER_ALLOWANCES, workspace));
    return this.budget.summary();
  }
  setSpendingPolicy(enabled: boolean, limitMicros: number | null) { this.budget.policy(enabled, limitMicros); }
  async reserve(workspace: string, input: ReserveInput) {
    return this.ctx.blockConcurrencyWhile(async () => {
      this.partner.renew(partnerAllowance(this.env.PARTNER_ALLOWANCES, workspace));
      const customer = await this.ctx.storage.get<string>("stripeCustomer");
      let result;
      try { result = this.budget.reserve(input); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== "insufficient_credit" || !customer) throw error;
        await this.topups.maybeRefill(workspace, customer, this.budget.summary(), input.maximumMicros, this.env.TOPUPS_ENABLED === "true");
        return this.budget.reserve(input);
      }
      // Low-balance replenishment follows an admitted paid request. Never charge for free inference.
      if (customer && result.paidMicros > 0 && result.status === "reserved") {
        const summary = this.budget.summary();
        await this.topups.maybeRefill(workspace, customer, summary, summary.promotionalMicros + 1, this.env.TOPUPS_ENABLED === "true").catch(() => { /* An admitted request must retain its reservation even if payment setup fails. */ });
      }
      return result;
    });
  }
  topupStatus() { return this.topups.status(); }
  async setupTopups(workspace: string, actor: string, input: TopupSettings) {
    if (this.env.TOPUPS_ENABLED !== "true") throw new Error("Automatic topups disabled");
    return this.ctx.blockConcurrencyWhile(async () => {
      return this.topups.setup(workspace, await this.customer(workspace), actor, input, new URL(this.env.BETTER_AUTH_URL).origin);
    });
  }
  async confirmTopups(workspace: string, session: string) {
    if (this.env.TOPUPS_ENABLED !== "true") throw new Error("Automatic topups disabled");
    return this.ctx.blockConcurrencyWhile(async () => this.topups.finishSetup(workspace, await this.customer(workspace), session));
  }
  disableTopups(actor: string) { return this.topups.disable(actor); }
  async reconcileTopups(workspace: string) {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.topups.refreshPending(workspace, false);
      return this.topups.status();
    });
  }
  private async customer(workspace: string) {
    let customer = await this.ctx.storage.get<string>("stripeCustomer");
    if (!customer) {
      const result = await stripeRequest(this.env.STRIPE_SECRET_KEY ?? "", "customers", new URLSearchParams({ "metadata[outfitter_workspace]": workspace }), `customer:${workspace}`);
      if (typeof result.id !== "string" || !result.id.startsWith("cus_")) throw new Error("Invalid payment customer");
      customer = result.id;
      await this.ctx.storage.put("stripeCustomer", customer);
    }
    return customer!;
  }
  settle(id: string, actualMicros: number) { return this.budget.settle(id, actualMicros); }
  release(id: string) { return this.budget.settle(id, 0); }

  async checkout(workspace: string, purchaseId: string, cents: number) {
    purchaseCents(cents);
    return this.ctx.blockConcurrencyWhile(async () => {
      const secret = this.env.STRIPE_SECRET_KEY ?? "";
      const customer = await this.customer(workspace);
      this.ledger.begin(purchaseId, cents, customer!);
      const existing = await this.ctx.storage.get<{ url: string; expires: number }>(`checkout:${purchaseId}`);
      if (existing) {
        if (existing.expires <= Date.now()) throw new Error("Checkout expired; start a new purchase");
        return { url: existing.url };
      }
      const attempted = await this.ctx.storage.get<number>(`attempt:${purchaseId}`);
      if (attempted && Date.now() - attempted > 23 * 60 * 60_000) throw new Error("Purchase needs reconciliation; use a new purchase ID");
      if (!attempted) await this.ctx.storage.put(`attempt:${purchaseId}`, Date.now());
      const origin = new URL(this.env.BETTER_AUTH_URL).origin;
      const result = await stripeRequest(secret, "checkout/sessions", new URLSearchParams({
        mode: "payment", customer: customer!, client_reference_id: purchaseId,
        "payment_method_types[0]": "card",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": String(cents),
        "line_items[0][price_data][product_data][name]": "Outfitter inference credit",
        "line_items[0][quantity]": "1",
        "payment_intent_data[metadata][outfitter_workspace]": workspace,
        "payment_intent_data[metadata][outfitter_purchase]": purchaseId,
        success_url: `${origin}/billing/?payment=complete`, cancel_url: `${origin}/billing/`,
      }), `purchase:${workspace}:${purchaseId}`);
      const url = new URL(String(result.url));
      if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com") throw new Error("Invalid checkout destination");
      await this.ctx.storage.put(`checkout:${purchaseId}`, { url: url.href, expires: Number(result.expires_at) * 1000 });
      return { url: url.href };
    });
  }

  async reconcile(workspace: string, paymentId: string) {
    return this.ctx.blockConcurrencyWhile(() => this.reconcilePayment(workspace, paymentId));
  }
  private async reconcilePayment(workspace: string, paymentId: string) {
      const payment = await stripeRequest(this.env.STRIPE_SECRET_KEY ?? "", `payment_intents/${encodeURIComponent(paymentId)}?expand[]=latest_charge`);
      if (payment.metadata?.outfitter_workspace !== workspace || payment.currency !== "usd") throw new Error("Payment workspace mismatch");
      if (payment.status !== "succeeded") return;
      const charge = payment.latest_charge;
      if (!charge || typeof charge !== "object" || typeof charge.disputed !== "boolean") throw new Error("Payment charge unavailable");
      let disputed = charge.disputed;
      if (disputed) {
        const disputes = await stripeRequest(this.env.STRIPE_SECRET_KEY ?? "", `disputes?charge=${encodeURIComponent(charge.id)}&limit=100`);
        if (!Array.isArray(disputes.data) || disputes.data.length === 0 || disputes.has_more) throw new Error("Dispute status unavailable");
        disputed = disputes.data.some((item: { status: string }) => item.status !== "won" && item.status !== "warning_closed");
      }
      return this.ledger.reconcile({
        id: payment.metadata.outfitter_purchase, payment: payment.id, customer: payment.customer,
        receivedCents: payment.amount_received, refundedCents: charge.amount_refunded, disputed,
      });
  }
}
