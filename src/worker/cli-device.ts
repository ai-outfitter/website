import { DurableObject } from "cloudflare:workers";
import { ACCESS_SECONDS, REFRESH_SECONDS, accessAllowed, digest, poll, randomSecret, type CliIdentity, type DeviceState, type Workspace } from "./cli-state";

/** One object per device. All state transitions are synchronous after hashing. */
export class CliDevice extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
  }
  #read(): DeviceState | undefined {
    // Alarms can delete all storage while this object instance remains alive.
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM state WHERE id=1").toArray()[0];
    return row ? JSON.parse(row.value) : undefined;
  }
  #write(value: DeviceState) {
    this.ctx.storage.sql.exec("INSERT INTO state VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", JSON.stringify(value));
  }
  async create(secret: string) {
    const hash = await digest(secret);
    if (this.#read()) return false;
    const expires = Date.now() + 600_000;
    this.#write({ deviceHash: hash, expires, nextPoll: 0, interval: 5000 });
    await this.ctx.storage.setAlarm(expires);
    return true;
  }
  approve(user: CliIdentity, workspace: Workspace, denied = false) {
    const state = this.#read();
    if (!state || state.expires <= Date.now() || state.user || state.denied || state.consumed) return false;
    if (denied) state.denied = true;
    else { state.user = user; state.workspace = workspace; }
    this.#write(state);
    return true;
  }
  async exchange(secret: string, refresh = false) {
    const [hash, access, nextRefresh] = await Promise.all([digest(secret), Promise.resolve(randomSecret()), Promise.resolve(randomSecret())]);
    const [accessHash, refreshHash] = await Promise.all([digest(access), digest(nextRefresh)]);
    const now = Date.now();
    const state = this.#read();
    if (!state) return { error: "invalid_grant" };
    if (refresh) {
      if (state.refreshHash !== hash || (state.refreshExpires ?? 0) <= now) return { error: "invalid_grant" };
    } else {
      const error = poll(state, hash, now);
      this.#write(state);
      if (error) return { error };
    }
    state.accessHash = accessHash;
    state.accessExpires = now + ACCESS_SECONDS * 1000;
    state.refreshHash = refreshHash;
    // Absolute lifetime: refreshing cannot keep an abandoned session alive forever.
    state.refreshExpires ??= now + REFRESH_SECONDS * 1000;
    this.#write(state);
    await this.ctx.storage.setAlarm(state.refreshExpires);
    return { access, refresh: nextRefresh, expires_in: ACCESS_SECONDS };
  }
  async authenticate(secret: string) {
    const hash = await digest(secret);
    const state = this.#read();
    return accessAllowed(state, hash, Date.now()) ? { user: state.user, workspace: state.workspace } : null;
  }
  async select(secret: string, workspace: Workspace) {
    const hash = await digest(secret);
    const state = this.#read();
    if (!accessAllowed(state, hash, Date.now())) return false;
    state.workspace = workspace;
    this.#write(state);
    return true;
  }
  async revoke(secret: string) {
    const hash = await digest(secret);
    const state = this.#read();
    // The last issued token may revoke its own session after access expiry; it cannot spend.
    if (!state?.user || !state.accessHash || state.accessHash.length !== hash.length) return false;
    // Fixed-length digest comparison, with no await between checking and revoking.
    let difference = 0;
    for (let index = 0; index < hash.length; index++) difference |= state.accessHash.charCodeAt(index) ^ hash.charCodeAt(index);
    if (difference !== 0) return false;
    this.ctx.storage.sql.exec("DELETE FROM state");
    return true;
  }
  async rateLimit() {
    // Separate objects named rate:<hashed IP>; no raw IP stored.
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS rate (id INTEGER PRIMARY KEY, reset INTEGER, count INTEGER)");
    const now = Date.now();
    const row = this.ctx.storage.sql.exec<{ reset: number; count: number }>("SELECT reset, count FROM rate WHERE id=1").toArray()[0];
    const reset = row && row.reset > now ? row.reset : now + 60_000;
    const count = row && row.reset > now ? row.count + 1 : 1;
    this.ctx.storage.sql.exec("INSERT INTO rate VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET reset=excluded.reset, count=excluded.count", reset, count);
    if (!row || row.reset <= now) await this.ctx.storage.setAlarm(reset);
    return count <= 20;
  }
  spenders(ids?: string[]) {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS spenders (id TEXT PRIMARY KEY)");
    if (ids) this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM spenders");
      for (const id of ids) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO spenders VALUES (?)", id);
    });
    return this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM spenders ORDER BY id").toArray().map((row) => row.id);
  }
  email(value?: string) {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS email (id INTEGER PRIMARY KEY, value TEXT)");
    if (value !== undefined) this.ctx.storage.sql.exec("INSERT INTO email VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", value);
    return this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM email WHERE id=1").toArray()[0]?.value || undefined;
  }
  async alarm() {
    const state = this.#read();
    const expires = state?.refreshExpires ?? state?.expires ?? 0;
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS rate (id INTEGER PRIMARY KEY, reset INTEGER, count INTEGER)");
    const reset = this.ctx.storage.sql.exec<{ reset: number }>("SELECT reset FROM rate WHERE id=1").toArray()[0]?.reset ?? 0;
    const next = Math.max(expires, reset);
    if (next > Date.now()) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAll();
  }
}
