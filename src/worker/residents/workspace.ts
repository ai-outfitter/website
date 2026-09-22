import { DurableObject } from "cloudflare:workers";
import { digest, randomSecret } from "../cli-state";
import { validateEnrollment, type Enrollment, type ResidentConfiguration, type TriageTask } from "./contracts";
import { verifyResidentToken } from "./credentials";
import { verifyRepositoryScope } from "./github";
import { provisionResidents, residentStatus, sendTriage } from "./operator";

interface Delivery { task: TriageTask; revision: string; state: "pending" | "sending" | "accepted" | "cancelled"; leaseUntil: number; attempts: number }
/** Stable per-workspace enrollment and durable issue delivery outbox. */
export class ResidentWorkspace extends DurableObject<Env> {
  configuration() { return this.ctx.storage.get<ResidentConfiguration>("configuration"); }
  async enroll(input: Enrollment) {
    validateEnrollment(input);
    const deploymentFingerprint = await digest(JSON.stringify({ origin: new URL(this.env.BETTER_AUTH_URL).origin, key: this.env.RESIDENT_CREDENTIAL_SECRET }));
    const config = await this.ctx.storage.transaction(async (txn) => {
      const old = await txn.get<ResidentConfiguration>("configuration");
      if (old && old.workspace.id !== input.workspace.id) throw new Error("Workspace collision");
      // Exact retries preserve the desired revision and tokens. Re-enabling rotates credentials.
      const same = old?.enabled && old.deploymentFingerprint === deploymentFingerprint && JSON.stringify({ workspace: old.workspace, installationId: old.installationId, repositories: old.repositories, projectManagerName: old.projectManagerName, engineerName: old.engineerName }) === JSON.stringify(input);
      const value: ResidentConfiguration = { ...input, enabled: true, credentialVersion: old?.enabled && old.deploymentFingerprint === deploymentFingerprint ? old.credentialVersion : randomSecret(16), revision: same ? old.revision : crypto.randomUUID(), generation: same ? old.generation : (old?.generation ?? 0) + 1, deploymentFingerprint };
      await txn.put("configuration", value);
      await txn.put("provisionPending", true);
      return value;
    });
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    return this.reconcile(config);
  }
  async disable() {
    await this.ctx.storage.transaction(async (txn) => {
      const config = await txn.get<ResidentConfiguration>("configuration");
      if (config) await txn.put("configuration", { ...config, enabled: false, credentialVersion: randomSecret(16), revision: crypto.randomUUID(), generation: config.generation + 1 });
      await txn.put("provisionPending", false);
    });
    return { enabled: false };
  }
  async authenticate(token: string, role: "project-manager" | "engineer", version: string) {
    const config = await this.configuration();
    if (!config?.enabled || config.credentialVersion !== version || !this.env.RESIDENT_CREDENTIAL_SECRET) return null;
    return await verifyResidentToken(this.env.RESIDENT_CREDENTIAL_SECRET, token, config.workspace.id, role, version) ? config : null;
  }
  async status() {
    const config = await this.configuration();
    if (!config) return { enrolled: false };
    const { credentialVersion: _secretVersion, deploymentFingerprint: _fingerprint, ...visible } = config;
    if (!config.enabled) return { enrolled: true, ...visible, state: "disabled", agents: [] };
    try {
      const status = await residentStatus(this.env, config.workspace.id);
      if (status.generation !== config.generation || await this.ctx.storage.get("provisionPending")) return { enrolled: true, ...visible, state: "provisioning", agents: status.agents.map((agent) => ({ ...agent, ready: false })) };
      return { enrolled: true, ...visible, ...status };
    }
    catch { return { enrolled: true, ...visible, state: "failed", agents: [], reason: "Resident operator unavailable; retry after checking its connection" }; }
  }
  private async reconcile(config: ResidentConfiguration) {
    const claimed = await this.ctx.storage.transaction(async (txn) => {
      const lease = await txn.get<number>("provisionLease");
      const current = await txn.get<ResidentConfiguration>("configuration");
      if ((lease ?? 0) > Date.now() || !current?.enabled || current.revision !== config.revision) return false;
      await txn.put("provisionLease", Date.now() + 30_000);
      return true;
    });
    if (!claimed) return { enrolled: true, state: "provisioning", agents: [] };
    try {
      const status = await provisionResidents(this.env, config);
      if (status.generation !== config.generation) throw new Error("Operator generation mismatch");
      const current = await this.ctx.storage.transaction(async (txn) => {
        const latest = await txn.get<ResidentConfiguration>("configuration");
        await txn.delete("provisionLease");
        if (latest?.revision !== config.revision || !latest.enabled) return false;
        await txn.put("provisionPending", false);
        return true;
      });
      return current ? { enrolled: true, ...status } : { enrolled: true, state: "provisioning", agents: [] };
    } catch {
      await this.ctx.storage.delete("provisionLease");
      return { enrolled: true, state: "failed", agents: [], reason: "Provisioning could not finish; retry is scheduled" };
    }
  }
  async enqueue(installationId: number, task: TriageTask) {
    const key = `task:${task.id}`;
    const result = await this.ctx.storage.transaction(async (txn) => {
      const config = await txn.get<ResidentConfiguration>("configuration");
      if (!config?.enabled || config.installationId !== installationId || !config.repositories.some((repo) => repo.id === task.repository.id && repo.fullName === task.repository.fullName)) return "ignored";
      const old = await txn.get<Delivery>(key);
      if (old) return old.state;
      await txn.put(key, { task, revision: config.revision, state: "pending", leaseUntil: 0, attempts: 0 } satisfies Delivery);
      await txn.put(`pending:${task.id}`, true);
      return "pending";
    });
    if (result !== "pending") return result;
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    await this.deliver(key);
    return (await this.ctx.storage.get<Delivery>(key))?.state ?? "pending";
  }
  private async deliver(key: string) {
    const claimed = await this.ctx.storage.transaction(async (txn) => {
      const config = await txn.get<ResidentConfiguration>("configuration");
      const delivery = await txn.get<Delivery>(key);
      if (!delivery || ["accepted", "cancelled"].includes(delivery.state) || delivery.leaseUntil > Date.now()) return null;
      if (!config?.enabled || config.revision !== delivery.revision || !config.repositories.some((repo) => repo.id === delivery.task.repository.id && repo.fullName === delivery.task.repository.fullName)) { await txn.put(key, { ...delivery, state: "cancelled" }); await txn.delete(`pending:${delivery.task.id}`); return null; }
      await txn.put(key, { ...delivery, state: "sending", leaseUntil: Date.now() + 30_000, attempts: delivery.attempts + 1 });
      return { config, delivery };
    });
    if (!claimed) return;
    try {
      await verifyRepositoryScope(this.env, claimed.config, claimed.delivery.task.repository.id);
      const current = await this.configuration();
      if (!current?.enabled || current.revision !== claimed.config.revision) {
        await this.ctx.storage.transaction(async (txn) => {
          await txn.put(key, { ...claimed.delivery, state: "cancelled", leaseUntil: 0 });
          await txn.delete(`pending:${claimed.delivery.task.id}`);
        });
        return;
      }
      await sendTriage(this.env, claimed.config.workspace.id, claimed.delivery.task);
      await this.ctx.storage.transaction(async (txn) => {
        await txn.put(key, { ...claimed.delivery, state: "accepted", leaseUntil: 0 });
        await txn.delete(`pending:${claimed.delivery.task.id}`);
      });
    } catch {
      await this.ctx.storage.put(key, { ...claimed.delivery, state: "pending", leaseUntil: 0, attempts: claimed.delivery.attempts + 1 });
    }
  }
  async alarm() {
    if (String(this.env.RESIDENTS_ENABLED) !== "true") { await this.ctx.storage.setAlarm(Date.now() + 300_000); return; }
    const config = await this.configuration();
    if (!config?.enabled) return;
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    if (await this.ctx.storage.get("provisionPending")) await this.reconcile(config);
    const cursor = await this.ctx.storage.get<string>("pendingCursor");
    let tasks = await this.ctx.storage.list({ prefix: "pending:", startAfter: cursor, limit: 20 });
    if (!tasks.size && cursor) tasks = await this.ctx.storage.list({ prefix: "pending:", limit: 20 });
    for (const [key] of tasks) {
      await this.deliver(`task:${key.slice("pending:".length)}`);
      await this.ctx.storage.put("pendingCursor", key);
    }
    await this.ctx.storage.transaction(async (txn) => {
      const pending = await txn.list({ prefix: "pending:", limit: 1 });
      if (!pending.size && !await txn.get("provisionPending")) await txn.deleteAlarm();
    });
  }
}
