import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { UsageBudget } from "./budget";
import { CreditLedger } from "./ledger";
import { PartnerCredit } from "./partner-credit";

const september = Date.parse("2026-09-22T12:00:00Z");
const october = Date.parse("2026-10-01T00:00:00Z");
function setup() {
  const db = new DatabaseSync(":memory:");
  const sql = { exec(query: string, ...args: never[]) { const rows = db.prepare(query).all(...args); return { toArray: () => rows, one: () => rows[0] }; } } as unknown as SqlStorage;
  const transaction = <T>(fn: () => T) => { db.exec("BEGIN"); try { const value = fn(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  const ledger = new CreditLedger(sql, transaction);
  const partner = new PartnerCredit(sql, transaction);
  const budget = new UsageBudget(sql, transaction);
  const id = "00000000-0000-4000-8000-000000000001";
  ledger.begin(id, 1000, "cus_example");
  ledger.reconcile({ id, customer: "cus_example", payment: "pi_example", receivedCents: 1000, refundedCents: 0, disputed: false });
  return { budget, partner, ledger };
}
const request = (id: string, maximumMicros: number) => ({ id, maximumMicros, userId: "github:42", model: "example", rateVersion: "v1" });
describe("account usage admission", () => {
  it("requires paid opt-in, but permits free partner credit", () => {
    const { budget, partner } = setup();
    expect(() => budget.reserve(request("a", 100), september)).toThrow("insufficient_credit");
    partner.renew(100, september);
    expect(budget.reserve(request("a", 100), september).promotionalMicros).toBe(100);
    expect(() => budget.reserve(request("b", 1), september)).toThrow("insufficient_credit");
  });
  it("serializes reservations against both balance and monthly cap", () => {
    const { budget } = setup();
    budget.policy(true, 8_000_000);
    budget.reserve(request("a", 5_000_000), september);
    expect(() => budget.reserve(request("b", 4_000_000), september)).toThrow("paid_limit_reached");
    budget.reserve(request("b", 3_000_000), september);
    budget.settle("a", 2_000_000, september);
    expect(budget.summary(september).paidMicros).toBe(5_000_000);
    budget.reserve(request("c", 3_000_000), september);
    expect(() => budget.reserve(request("d", 1), september)).toThrow("paid_limit_reached");
  });
  it("settles free credit first and returns unused holds only once", () => {
    const { budget, partner } = setup();
    budget.policy(true, null);
    partner.renew(3_000_000, september);
    budget.reserve(request("a", 5_000_000), september);
    budget.settle("a", 1_000_000, september);
    budget.settle("a", 1_000_000, september);
    expect(partner.balance(september)).toBe(2_000_000);
    expect(budget.summary(september).paidMicros).toBe(10_000_000);
    expect(() => budget.settle("a", 0, september)).toThrow("Conflicting settlement");
  });
  it("retains unknown-cost holds and rejects settlement above the reservation", () => {
    const { budget } = setup();
    budget.policy(true, null);
    budget.reserve(request("a", 100), september);
    expect(() => budget.settle("a", 101, september)).toThrow("reconciliation required");
    expect(budget.summary(september).paidMicros).toBe(9_999_900);
    expect(budget.reserve(request("a", 100), september).status).toBe("reserved");
    expect(() => budget.reserve(request("a", 200), september)).toThrow("already exists");
  });
  it("never rolls an expired or revoked promotional hold into a later grant", () => {
    const { budget, partner } = setup();
    partner.renew(100, september);
    budget.reserve(request("a", 100), september);
    partner.renew(100, october);
    budget.settle("a", 0, october);
    expect(partner.balance(october)).toBe(100);
    budget.reserve(request("b", 100), october);
    partner.renew(null, october);
    budget.settle("b", 0, october);
    expect(partner.balance(october)).toBe(0);
  });
  it("uncapped still requires a prepaid balance and refunds can suspend admission", () => {
    const { budget, ledger } = setup();
    budget.policy(true, null);
    expect(() => budget.reserve(request("a", 11_000_000), september)).toThrow("insufficient_credit");
    budget.reserve(request("a", 1_000_000), september);
    budget.settle("a", 1_000_000, september);
    ledger.reconcile({ id: "00000000-0000-4000-8000-000000000001", customer: "cus_example", payment: "pi_example", receivedCents: 1000, refundedCents: 1000, disputed: false });
    expect(() => budget.reserve(request("b", 0), september)).toThrow("insufficient_credit");
  });
});
