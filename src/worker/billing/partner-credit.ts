export function utcMonth(now: number): string {
  if (!Number.isFinite(now)) throw new Error("Invalid time");
  return new Date(now).toISOString().slice(0, 7);
}

/** Operator-owned configuration. No browser request can assign an allowance. */
export function partnerAllowance(configuration: string | undefined, workspace: string): number | null {
  const values: unknown = JSON.parse(configuration || "{}");
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Invalid partner allowances");
  const amount = (values as Record<string, unknown>)[workspace];
  if (amount === undefined || amount === null) return null;
  if (!Number.isSafeInteger(amount) || Number(amount) < 0 || Number(amount) > 1_000_000_000_000) throw new Error("Invalid partner allowance");
  return Number(amount);
}

export class PartnerCredit {
  constructor(private readonly sql: SqlStorage, private readonly transaction: <T>(fn: () => T) => T) {
    sql.exec("CREATE TABLE IF NOT EXISTS partner_credits (period TEXT PRIMARY KEY, granted INTEGER NOT NULL, remaining INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)");
    sql.exec("CREATE TABLE IF NOT EXISTS partner_entries (id INTEGER PRIMARY KEY, period TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL)");
  }

  renew(allowance: number | null, now = Date.now()) {
    if (allowance !== null && (!Number.isSafeInteger(allowance) || allowance < 0)) throw new Error("Invalid allowance");
    const period = utcMonth(now);
    return this.transaction(() => {
      for (const row of this.sql.exec<{ period: string; remaining: number }>("SELECT period,remaining FROM partner_credits WHERE period < ? AND remaining > 0", period).toArray()) {
        this.sql.exec("INSERT INTO partner_entries (period,kind,amount) VALUES (?,'expiry',?)", row.period, -row.remaining);
      }
      this.sql.exec("UPDATE partner_credits SET remaining=0 WHERE period < ?", period);
      const current = this.sql.exec<{ remaining: number }>("SELECT remaining FROM partner_credits WHERE period=?", period).toArray()[0];
      if (allowance === null && current) {
        if (current.remaining) this.sql.exec("INSERT INTO partner_entries (period,kind,amount) VALUES (?,'revocation',?)", period, -current.remaining);
        this.sql.exec("UPDATE partner_credits SET remaining=0,revoked=1 WHERE period=?", period);
      } else if (allowance !== null && !current) {
        this.sql.exec("INSERT INTO partner_credits (period,granted,remaining) VALUES (?,?,?)", period, allowance, allowance);
        this.sql.exec("INSERT INTO partner_entries (period,kind,amount) VALUES (?,'grant',?)", period, allowance);
      }
      return this.balance(now);
    });
  }

  balance(now = Date.now()) {
    return this.sql.exec<{ remaining: number }>("SELECT remaining FROM partner_credits WHERE period=?", utcMonth(now)).toArray()[0]?.remaining ?? 0;
  }
}
