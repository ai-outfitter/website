import { base64url, decodeKey, secureEqual } from "../crypto";
import type { ResidentRole } from "./contracts";
export type CredentialRole = ResidentRole | "task";
export async function residentToken(secret: string, workspace: string, role: CredentialRole, version: string) {
  if (!/^(user|org):[1-9]\d*$/.test(workspace) || !/^[a-f0-9]{32}$/.test(version)) throw new Error("Invalid resident credential identity");
  const prefix = `ofr.${workspace.replace(":", ".")}.${role}.${version}`;
  const key = await crypto.subtle.importKey("raw", decodeKey(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${prefix}.${base64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(prefix)))}`;
}
export function parseResidentToken(value: string | null) {
  const match = value?.replace(/^Bearer /i, "").match(/^ofr\.(user|org)\.([1-9]\d*)\.(project-manager|engineer)\.([a-f0-9]{32})\.([\w-]{43})$/);
  return match ? { token: value!.replace(/^Bearer /i, ""), workspace: `${match[1]}:${match[2]}`, role: match[3] as ResidentRole, version: match[4] } : null;
}
export async function verifyResidentToken(secret: string, token: string, workspace: string, role: ResidentRole, version: string) {
  return secureEqual(token, await residentToken(secret, workspace, role, version));
}
