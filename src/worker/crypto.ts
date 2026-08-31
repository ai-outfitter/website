const encoder = new TextEncoder();

export function decodeKey(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  let binary: string;
  try { binary = atob(`${normalized}${"=".repeat((4 - normalized.length % 4) % 4)}`); }
  catch { throw new Error("Invalid encryption key"); }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.length !== 32) throw new Error("Encryption key must contain 32 bytes");
  return bytes;
}

export async function encryptionKey(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", decodeKey(value), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(key: CryptoKey, userId: number, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(`github-grant/v1:${userId}`) }, key, encoder.encode(value));
  return { iv: iv.buffer, data };
}

export async function decrypt(key: CryptoKey, userId: number, iv: ArrayBuffer, data: ArrayBuffer) {
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(`github-grant/v1:${userId}`) }, key, data));
}

export function base64url(bytes: ArrayBuffer | Uint8Array) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...view)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function secureEqual(left: string, right: string) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}
