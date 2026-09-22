import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { PartnerCredit, partnerAllowance } from "./partner-credit";

function credit() {
  const db = new DatabaseSync(":memory:");
  const sql = { exec(query: string, ...args: never[]) {
    const rows = db.prepare(query).all(...args);
    return { toArray: () => rows, one: () => rows[0] };
  } } as unknown as SqlStorage;
  return new PartnerCredit(sql, (fn) => {
    db.exec("BEGIN");
    try { const value = fn(); db.exec("COMMIT"); return value; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  });
}
const september = Date.parse("2026-09-22T12:00:00Z");
const october = Date.parse("2026-10-01T00:00:00Z");
describe("partner monthly credit", () => {
  it("grants once per UTC month, without rollover or a card", () => {
    const store = credit();
    expect(store.renew(20_000_000, september)).toBe(20_000_000);
    expect(store.renew(20_000_000, september)).toBe(20_000_000);
    expect(store.balance(october)).toBe(0);
    expect(store.renew(20_000_000, october)).toBe(20_000_000);
  });
  it("revokes unused allowance without allowing reenrollment to mint it again", () => {
    const store = credit();
    store.renew(20_000_000, september);
    expect(store.renew(null, september)).toBe(0);
    expect(store.renew(20_000_000, september)).toBe(0);
    expect(store.renew(30_000_000, october)).toBe(30_000_000);
  });
  it("applies amount changes on the next renewal", () => {
    const store = credit();
    store.renew(20_000_000, september);
    expect(store.renew(30_000_000, september)).toBe(20_000_000);
    expect(store.renew(30_000_000, october)).toBe(30_000_000);
  });
  it("accepts only operator-provided integer amounts for the exact account", () => {
    expect(partnerAllowance('{"org:42":20000000}', "org:42")).toBe(20_000_000);
    expect(partnerAllowance('{"org:42":20000000}', "user:42")).toBeNull();
    expect(() => partnerAllowance('{"org:42":-1}', "org:42")).toThrow();
    expect(() => partnerAllowance('[]', "org:42")).toThrow();
  });
});
