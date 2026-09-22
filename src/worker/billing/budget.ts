import { utcMonth } from "./partner-credit";

type Reservation = Record<string, SqlStorageValue> & {
  id: string; period: string; maximum: number; promotional: number; paid: number; status: string;
  actual: number | null; user_id: string; model: string; rate_version: string;
};
export type ReserveInput = { id: string; maximumMicros: number; userId: string; model: string; rateVersion: string };

function money(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000) throw new Error("Invalid monetary amount");
}

/** Atomic account-level admission, including all concurrent unsettled requests. */
export class UsageBudget {
  constructor(private readonly sql: SqlStorage, private readonly transaction: <T>(fn: () => T) => T) {
    sql.exec("CREATE TABLE IF NOT EXISTS spending_policy (singleton INTEGER PRIMARY KEY CHECK(singleton=1), enabled INTEGER NOT NULL DEFAULT 0, limit_micros INTEGER)");
    sql.exec("INSERT OR IGNORE INTO spending_policy (singleton) VALUES (1)");
    sql.exec(`CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY, period TEXT NOT NULL, maximum INTEGER NOT NULL, promotional INTEGER NOT NULL, paid INTEGER NOT NULL,
      status TEXT NOT NULL, actual INTEGER, user_id TEXT NOT NULL, model TEXT NOT NULL, rate_version TEXT NOT NULL
    )`);
    sql.exec("CREATE INDEX IF NOT EXISTS reservations_period ON reservations(period,status)");
  }

  policy(enabled: boolean, limitMicros: number | null) {
    if (typeof enabled !== "boolean") throw new Error("Invalid spending policy");
    if (limitMicros !== null) money(limitMicros);
    this.sql.exec("UPDATE spending_policy SET enabled=?,limit_micros=? WHERE singleton=1", enabled ? 1 : 0, limitMicros);
  }

  summary(now = Date.now()) {
    const period = utcMonth(now);
    const policy = this.sql.exec<{ enabled: number; limit_micros: number | null }>("SELECT enabled,limit_micros FROM spending_policy WHERE singleton=1").one();
    const paid = this.sql.exec<{ balance: number }>("SELECT COALESCE(SUM(amount),0) AS balance FROM credit_entries").one().balance;
    const held = this.sql.exec<{ held: number }>("SELECT COALESCE(SUM(paid),0) AS held FROM reservations WHERE status='reserved'").one().held;
    const used = this.sql.exec<{ used: number }>("SELECT COALESCE(SUM(paid),0) AS used FROM reservations WHERE period=? AND status='settled'", period).one().used;
    const pending = this.sql.exec<{ held: number }>("SELECT COALESCE(SUM(paid),0) AS held FROM reservations WHERE period=? AND status='reserved'", period).one().held;
    const promotional = this.sql.exec<{ remaining: number }>("SELECT remaining FROM partner_credits WHERE period=?", period).toArray()[0]?.remaining ?? 0;
    return { currency: "usd" as const, period, paidMicros: paid - held, promotionalMicros: promotional,
      paidUsedMicros: used, paidReservedMicros: pending, paidLimitMicros: policy.limit_micros, paidEnabled: Boolean(policy.enabled) };
  }

  reserve(input: ReserveInput, now = Date.now()) {
    money(input.maximumMicros);
    if (!input.id || !input.userId || !input.model || !input.rateVersion) throw new Error("Missing reservation identity");
    return this.transaction(() => {
      const previous = this.row(input.id);
      if (previous) {
        if (previous.maximum !== input.maximumMicros || previous.user_id !== input.userId || previous.model !== input.model || previous.rate_version !== input.rateVersion) throw new Error("Reservation already exists");
        return this.result(previous);
      }
      const summary = this.summary(now);
      const promotional = Math.min(summary.promotionalMicros, input.maximumMicros);
      const paid = input.maximumMicros - promotional;
      if (summary.paidMicros < 0 || (paid > 0 && (!summary.paidEnabled || paid > summary.paidMicros))) throw new Error("insufficient_credit");
      if (paid > 0 && summary.paidLimitMicros !== null && summary.paidUsedMicros + summary.paidReservedMicros + paid > summary.paidLimitMicros) throw new Error("paid_limit_reached");
      if (promotional) this.sql.exec("UPDATE partner_credits SET remaining=remaining-? WHERE period=?", promotional, summary.period);
      this.sql.exec("INSERT INTO reservations (id,period,maximum,promotional,paid,status,user_id,model,rate_version) VALUES (?,?,?,?,?,'reserved',?,?,?)", input.id, summary.period, input.maximumMicros, promotional, paid, input.userId, input.model, input.rateVersion);
      return this.result(this.row(input.id)!);
    });
  }

  settle(id: string, actualMicros: number, now = Date.now()) {
    money(actualMicros);
    return this.transaction(() => {
      const row = this.row(id);
      if (!row) throw new Error("Unknown reservation");
      if (row.status === "settled") {
        if (row.actual !== actualMicros) throw new Error("Conflicting settlement");
        return this.result(row);
      }
      if (actualMicros > row.promotional + row.paid) throw new Error("Cost exceeds reservation; reconciliation required");
      const promotional = Math.min(actualMicros, row.promotional);
      const paid = actualMicros - promotional;
      // Returns never roll promotional credit into a later month or revive a revoked grant.
      const grant = this.sql.exec<{ revoked: number }>("SELECT revoked FROM partner_credits WHERE period=?", row.period).toArray()[0];
      if (row.period === utcMonth(now) && grant?.revoked === 0) this.sql.exec("UPDATE partner_credits SET remaining=remaining+? WHERE period=?", row.promotional - promotional, row.period);
      else if (row.promotional > promotional) this.sql.exec("INSERT INTO partner_entries (period,kind,amount) VALUES (?,'expiry',?)", row.period, promotional - row.promotional);
      if (promotional) this.sql.exec("INSERT INTO partner_entries (period,kind,amount) VALUES (?,'usage',?)", row.period, -promotional);
      if (paid) this.sql.exec("INSERT INTO credit_entries (purchase,kind,amount,created) VALUES (?,'usage',?,?)", id, -paid, now);
      this.sql.exec("UPDATE reservations SET promotional=?,paid=?,actual=?,status='settled' WHERE id=?", promotional, paid, actualMicros, id);
      return this.result(this.row(id)!);
    });
  }

  private row(id: string) { return this.sql.exec<Reservation>("SELECT * FROM reservations WHERE id=?", id).toArray()[0]; }
  private result(row: Reservation) { return { id: row.id, status: row.status, promotionalMicros: row.promotional, paidMicros: row.paid }; }
}
