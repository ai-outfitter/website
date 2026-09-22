import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { CreditLedger } from "../billing/ledger";
import { PartnerCredit } from "../billing/partner-credit";
import { UsageBudget } from "../billing/budget";
import { inferenceRoute, type RequestRecord } from "./gateway";
import { chargeMicros } from "./models";

it("admits concurrent HTTP requests against the actual atomic account budget", async () => {
  const db = new DatabaseSync(":memory:");
  const sql = { exec(query: string, ...args: never[]) { const rows = db.prepare(query).all(...args); return { toArray: () => rows, one: () => rows[0] }; } } as unknown as SqlStorage;
  const transaction = <T>(fn: () => T) => { db.exec("BEGIN"); try { const value = fn(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  const ledger = new CreditLedger(sql, transaction);
  new PartnerCredit(sql, transaction);
  const budget = new UsageBudget(sql, transaction);
  ledger.begin("00000000-0000-4000-8000-000000000001", 1000, "cus_example");
  ledger.reconcile({ id: "00000000-0000-4000-8000-000000000001", customer: "cus_example", payment: "pi_example", receivedCents: 1000, refundedCents: 0, disputed: false });
  budget.policy(true, 40_000);
  const model = { id: "example", upstream: "example", name: "Example", provider: "example", contextLength: 10000, maxOutputTokens: 100, promptMicrosPerToken: 1, completionMicrosPerToken: 2, cacheReadMicrosPerToken: 0.5, cacheWriteMicrosPerToken: 1.25, requestMicros: 100 };
  let dispatches = 0;
  const responses = await Promise.all([1, 2].map(() => inferenceRoute(new Request("https://test/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "example", messages: [{ role: "user", content: "hello" }] }) }), {
    enabled: true, models: JSON.stringify({ models: [model], rate: { version: "test", markupBps: 2000 } }), openRouterKey: "private",
  }, {
    authorize: async () => ({ user: { id: "github:1" }, workspace: { id: "user:1", login: "alice", type: "User" } }),
    usage: async () => budget.summary(),
    recorder: () => {
      let reserved: RequestRecord;
      let cost: number | undefined;
      return {
        begin: async (input) => { reserved = input; budget.reserve({ ...input, rateVersion: input.rate.version }); },
        observe: async (value) => { cost = value.cost; },
        complete: async () => { if (cost !== undefined) budget.settle(reserved.id, chargeMicros(cost, reserved.rate)); },
        rejected: async () => { budget.settle(reserved.id, 0); },
      };
    },
    fetch: async () => { dispatches++; return Response.json({ id: "gen-1", usage: { cost: 0.02 } }); },
  })));
  expect(responses.map((response) => response!.status).sort()).toEqual([200, 402]);
  expect(dispatches).toBe(1);
  expect(budget.summary().paidUsedMicros).toBe(24_000);
  expect(budget.summary().paidReservedMicros).toBe(0);
  db.close();
});
