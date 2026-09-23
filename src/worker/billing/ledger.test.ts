import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CreditLedger } from "./ledger";

function ledger() {
  const db = new DatabaseSync(":memory:");
  const sql = { exec(query: string, ...args: unknown[]) {
    const statement = db.prepare(query);
    const rows = statement.all(...args as never[]);
    return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error("Expected one row"); return rows[0]; } };
  } } as unknown as SqlStorage;
  return new CreditLedger(sql, (fn) => {
    db.exec("BEGIN");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  });
}
const id = "00000000-0000-4000-8000-000000000001";
const payment = { id, payment: "pi_example", customer: "cus_example", receivedCents: 1000, refundedCents: 0, disputed: false };

describe("prepaid credit ledger", () => {
  it("credits a payment once across repeated deliveries and records cumulative refunds", () => {
    const store = ledger();
    store.begin(id, 1000, "cus_example");
    expect(store.balance().paidMicros).toBe(0);
    store.reconcile(payment);
    store.reconcile(payment);
    expect(store.balance().paidMicros).toBe(10_000_000);
    store.reconcile({ ...payment, refundedCents: 250 });
    store.reconcile(payment);
    expect(store.balance().paidMicros).toBe(7_500_000);
    store.reconcile({ ...payment, refundedCents: 1000 });
    expect(store.balance().paidMicros).toBe(0);
  });
  it("handles refund before success and does not double debit overlapping disputes", () => {
    const store = ledger();
    store.begin(id, 1000, "cus_example");
    store.reconcile({ ...payment, refundedCents: 250, disputed: true });
    expect(store.balance().paidMicros).toBe(0);
    store.reconcile({ ...payment, refundedCents: 250, disputed: false });
    expect(store.balance().paidMicros).toBe(7_500_000);
  });
  it("rejects cross-customer payments, amount mismatches, and reused purchase IDs", () => {
    const store = ledger();
    store.begin(id, 1000, "cus_example");
    expect(() => store.begin(id, 2000, "cus_example")).toThrow();
    expect(() => store.reconcile({ ...payment, customer: "cus_other" })).toThrow();
    expect(() => store.reconcile({ ...payment, receivedCents: 500 })).toThrow();
    expect(() => store.reconcile({ ...payment, refundedCents: -1 })).toThrow();
    expect(store.balance().paidMicros).toBe(0);
    store.reconcile(payment);
    expect(() => store.reconcile({ ...payment, payment: "pi_other" })).toThrow();
  });
  it("cannot credit one payment to two purchase IDs", () => {
    const store = ledger();
    store.begin(id, 1000, "cus_example");
    const other = "00000000-0000-4000-8000-000000000002";
    store.begin(other, 1000, "cus_example");
    store.reconcile(payment);
    expect(() => store.reconcile({ ...payment, id: other })).toThrow();
    expect(store.balance().paidMicros).toBe(10_000_000);
  });
});
