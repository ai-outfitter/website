import { DurableObject } from "cloudflare:workers";
import { decrypt, encrypt, encryptionKey } from "./crypto";
import { GitHubGrantRetryableError, refreshResponseClass } from "./grant-errors";

type Grant = { githubUserId: number; accessToken: string; accessTokenExpiresAt: number; refreshToken: string; refreshTokenExpiresAt: number };
type Row = Record<string, SqlStorageValue> & { github_user_id: number; refresh_ciphertext: ArrayBuffer; refresh_iv: ArrayBuffer; refresh_expires_at: number; generation: number };

export class GitHubUserGrant extends DurableObject<Env> {
  #access: { token: string; expires: number } | null = null;
  #refreshing: Promise<string> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => { this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS grant (singleton INTEGER PRIMARY KEY CHECK(singleton=1), github_user_id INTEGER NOT NULL, refresh_ciphertext BLOB NOT NULL, refresh_iv BLOB NOT NULL, refresh_expires_at INTEGER NOT NULL, generation INTEGER NOT NULL)`); });
  }

  async acceptOAuthGrant(grant: Grant) {
    if (!Number.isSafeInteger(grant.githubUserId) || !grant.accessToken || !grant.refreshToken) throw new Error("Invalid GitHub grant");
    const sealed = await encrypt(await encryptionKey(this.env.GITHUB_USER_TOKEN_ENCRYPTION_KEY), grant.githubUserId, grant.refreshToken);
    const current = this.#row();
    const generation = (current?.generation ?? 0) + 1;
    this.ctx.storage.sql.exec(`INSERT INTO grant VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET github_user_id=excluded.github_user_id, refresh_ciphertext=excluded.refresh_ciphertext, refresh_iv=excluded.refresh_iv, refresh_expires_at=excluded.refresh_expires_at, generation=excluded.generation`, grant.githubUserId, sealed.data, sealed.iv, grant.refreshTokenExpiresAt, generation);
    this.#access = { token: grant.accessToken, expires: grant.accessTokenExpiresAt };
    return { generation };
  }

  async getAccessToken() {
    if (this.#access && this.#access.expires > Date.now() + 60_000) return this.#access.token;
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = this.#refresh();
    try { return await this.#refreshing; } finally { this.#refreshing = null; }
  }

  async revoke() { this.ctx.storage.sql.exec("DELETE FROM grant"); this.#access = null; }
  #row() { return this.ctx.storage.sql.exec<Row>("SELECT * FROM grant WHERE singleton=1").toArray()[0] ?? null; }
  async #refresh() {
    const row = this.#row();
    if (!row || row.refresh_expires_at <= Date.now()) throw new Error("github_reauthorization_required");
    const refreshToken = await decrypt(await encryptionKey(this.env.GITHUB_USER_TOKEN_ENCRYPTION_KEY), row.github_user_id, row.refresh_iv, row.refresh_ciphertext);
    let response: Response;
    try {
      response = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: this.env.GITHUB_CLIENT_ID, client_secret: this.env.GITHUB_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: refreshToken }) });
    } catch { throw new GitHubGrantRetryableError(); }
    const responseClass = refreshResponseClass(response.status);
    if (responseClass === "retryable") throw new GitHubGrantRetryableError();
    if (responseClass === "terminal") { await this.revoke(); throw new Error("github_reauthorization_required"); }
    let payload: Record<string, unknown>;
    try { payload = await response.json<Record<string, unknown>>(); }
    catch { await this.revoke(); throw new Error("github_reauthorization_required"); }
    if (typeof payload.access_token !== "string" || typeof payload.refresh_token !== "string" || !Number.isFinite(Number(payload.expires_in)) || !Number.isFinite(Number(payload.refresh_token_expires_in))) { await this.revoke(); throw new Error("github_reauthorization_required"); }
    const now = Date.now();
    await this.acceptOAuthGrant({ githubUserId: row.github_user_id, accessToken: payload.access_token, accessTokenExpiresAt: now + Number(payload.expires_in) * 1000, refreshToken: payload.refresh_token, refreshTokenExpiresAt: now + Number(payload.refresh_token_expires_in) * 1000 });
    return payload.access_token;
  }
}
