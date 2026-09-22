export type Workspace = { id: string; login: string; type: "User" | "Organization" };
export type CliIdentity = { id: string; email?: string };
export type DeviceState = {
  deviceHash: string; expires: number; nextPoll: number; interval: number;
  user?: CliIdentity; workspace?: Workspace; consumed?: boolean; denied?: boolean;
  accessHash?: string; accessExpires?: number; refreshHash?: string; refreshExpires?: number;
};
export const ACCESS_SECONDS = 900;
export const REFRESH_SECONDS = 60 * 60 * 24 * 30;
export function randomSecret(bytes = 32) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (n) => n.toString(16).padStart(2, "0")).join("");
}
export async function digest(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (n) => n.toString(16).padStart(2, "0")).join("");
}
export function splitCredential(value: unknown): { id: string; secret: string } | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^([a-f0-9]{20})\.([a-f0-9]{64})$/);
  return match ? { id: match[1], secret: match[2] } : null;
}
export function poll(state: DeviceState, hash: string, now: number): string | null {
  if (state.deviceHash !== hash || state.consumed) return "invalid_grant";
  if (state.expires <= now) return "expired_token";
  if (now < state.nextPoll) {
    state.interval += 5000;
    state.nextPoll = now + state.interval;
    return "slow_down";
  }
  state.nextPoll = now + state.interval;
  if (state.denied) return "access_denied";
  if (!state.user) return "authorization_pending";
  state.consumed = true;
  return null;
}
export function accessAllowed(state: DeviceState | undefined, hash: string, now: number): state is DeviceState & { user: CliIdentity; workspace: Workspace } {
  return Boolean(state?.user && state.workspace && state.accessHash === hash && (state.accessExpires ?? 0) > now && (state.refreshExpires ?? 0) > now);
}
