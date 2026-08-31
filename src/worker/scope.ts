import { base64url } from "./crypto";

export type ScopedAccount = {
  login: string;
  type: "User" | "Organization";
  installationId: number;
  hasAgentsRepository: boolean;
};

const COOKIE = "outfitter_active_account";
const MAX_AGE = 60 * 60 * 24 * 90;

async function signature(value: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function cookieValue(headers: Headers) {
  const match = headers.get("cookie")?.match(/(?:^|;\s*)outfitter_active_account=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export async function readActiveAccount(headers: Headers, accounts: ScopedAccount[], personalLogin: string, secret: string) {
  const stored = cookieValue(headers);
  if (stored) {
    const [login, expires, mac, extra] = stored.split(".");
    const payload = `${login}.${expires}`;
    if (!extra && login && expires && mac && Number(expires) > Date.now() && await signature(payload, secret) === mac && accounts.some((account) => account.login === login)) return login;
  }
  return accounts.find((account) => account.login === personalLogin)?.login ?? accounts[0]?.login ?? null;
}

export async function activeAccountCookie(login: string, secret: string) {
  const expires = Date.now() + MAX_AGE * 1000;
  const payload = `${login}.${expires}`;
  return `${COOKIE}=${encodeURIComponent(`${payload}.${await signature(payload, secret)}`)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`;
}

export function viewedLogin(pathname: string) {
  const match = pathname.match(/^\/orgs\/([^/]+)(?:\/|$)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function installationReturnAccepted(value: string | null, accounts: ScopedAccount[]) {
  if (!value || !/^\d+$/.test(value)) return false;
  const id = Number(value);
  return Number.isSafeInteger(id) && accounts.some((account) => account.installationId === id);
}
