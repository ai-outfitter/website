import type { Account } from "better-auth";
import { betterAuth } from "better-auth";
import { memoryAdapter, type MemoryDB } from "better-auth/adapters/memory";

export function createAuth(env: Env, memory: MemoryDB = { user: [], session: [], account: [], verification: [] }) {
  const store = async (account: Partial<Account> & Record<string, unknown>) => {
    const userId = Number(account.accountId);
    const accessToken = String(account.accessToken ?? "");
    const refreshToken = String(account.refreshToken ?? "");
    if (!userId || !accessToken || !refreshToken || !(account.accessTokenExpiresAt instanceof Date) || !(account.refreshTokenExpiresAt instanceof Date)) throw new Error("GitHub App token expiry is required");
    await env.GITHUB_USER_GRANTS.getByName(String(userId)).acceptOAuthGrant({ githubUserId: userId, accessToken, refreshToken, accessTokenExpiresAt: account.accessTokenExpiresAt.getTime(), refreshTokenExpiresAt: account.refreshTokenExpiresAt.getTime() });
    return { data: { ...account, accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null } };
  };
  return betterAuth({
    database: memoryAdapter(memory), secret: env.BETTER_AUTH_SECRET, baseURL: env.BETTER_AUTH_URL,
    account: { storeStateStrategy: "cookie", storeAccountCookie: false },
    databaseHooks: { account: { create: { before: store }, update: { before: store } } },
    session: { cookieCache: { enabled: true, maxAge: 60 * 60 * 24 * 7 } },
    user: { additionalFields: { githubUserId: { type: "number", required: true, input: true, returned: true } } },
    socialProviders: { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, mapProfileToUser: (profile) => ({ githubUserId: Number(profile.id) }) } }
  });
}

export async function session(env: Env, headers: Headers) { return createAuth(env).api.getSession({ headers }); }
export async function userToken(env: Env, headers: Headers) {
  const current = await session(env, headers);
  const id = current?.user.githubUserId;
  if (typeof id !== "number" || id <= 0) throw new Response("Sign in required", { status: 401 });
  try { return await env.GITHUB_USER_GRANTS.getByName(String(id)).getAccessToken(); }
  catch { throw new Response("GitHub authorization expired", { status: 401 }); }
}
