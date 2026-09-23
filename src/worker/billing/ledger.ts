/** All amounts are integer USD microdollars. Stripe amounts are cents. */
export const MICROS_PER_CENT = 10_000;
export type Purchase = {
  id: string; cents: number; customer: string; payment: string | null;
  credited: number; reversed: number; disputed: number;
};

export function purchaseCents(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 500 || Number(value) > 100_000) {
    throw new Error("Choose between $5 and $1,000 in whole cents");
  }
  return Number(value);
}

export class CreditLedger {
  constructor(private readonly sql: SqlStorage, private readonly transaction: <T>(fn: () => T) => T) {
    sql.exec(`CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY, cents INTEGER NOT NULL, customer TEXT NOT NULL,
      payment TEXT UNIQUE, credited INTEGER NOT NULL DEFAULT 0,
      reversed INTEGER NOT NULL DEFAULT 0, disputed INTEGER NOT NULL DEFAULT 0
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS credit_entries (
      id INTEGER PRIMARY KEY, purchase TEXT NOT NULL, kind TEXT NOT NULL,
      amount INTEGER NOT NULL, created INTEGER NOT NULL
    )`);
  }

  purchase(id: string): Purchase | undefined {
    return this.sql.exec<Purchase & Record<string, SqlStorageValue>>("SELECT * FROM purchases WHERE id=?", id).toArray()[0];
  }

  begin(id: string, cents: number, customer: string) {
    purchaseCents(cents);
    if (!/^[a-f\d-]{36}$/.test(id) || !customer.startsWith("cus_")) throw new Error("Invalid purchase");
    const existing = this.purchase(id);
    if (existing && (existing.cents !== cents || existing.customer !== customer)) throw new Error("Purchase ID already used");
    this.sql.exec("INSERT OR IGNORE INTO purchases (id,cents,customer) VALUES (?,?,?)", id, cents, customer);
  }

  reconcile(input: { id: string; payment: string; customer: string; receivedCents: number; refundedCents: number; disputed: boolean }) {
    return this.transaction(() => {
      const purchase = this.purchase(input.id);
      if (!purchase || purchase.customer !== input.customer || purchase.cents !== input.receivedCents
        || !input.payment.startsWith("pi_") || (purchase.payment && purchase.payment !== input.payment)
        || !Number.isSafeInteger(input.refundedCents) || input.refundedCents < 0 || input.refundedCents > purchase.cents) {
        throw new Error("Payment does not match purchase");
      }
      const credited = purchase.cents * MICROS_PER_CENT;
      // Refund totals never decrease, even when a stale delivery is retried.
      const reversed = Math.max(purchase.reversed, input.refundedCents * MICROS_PER_CENT);
      const disputed = input.disputed ? credited - reversed : 0;
      for (const [kind, amount] of [
        ["purchase", credited - purchase.credited],
        ["refund", purchase.reversed - reversed],
        ["dispute", purchase.disputed - disputed],
      ] as const) {
        if (amount) this.sql.exec("INSERT INTO credit_entries (purchase,kind,amount,created) VALUES (?,?,?,?)", purchase.id, kind, amount, Date.now());
      }
      this.sql.exec("UPDATE purchases SET payment=?,credited=?,reversed=?,disputed=? WHERE id=?", input.payment, credited, reversed, disputed, purchase.id);
      return this.balance();
    });
  }

  balance() {
    const row = this.sql.exec<{ balance: number }>("SELECT COALESCE(SUM(amount),0) AS balance FROM credit_entries").one();
    return { currency: "usd" as const, paidMicros: row.balance };
  }
}
