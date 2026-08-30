import { describe, expect, it } from "vitest";
import { decodeKey, decrypt, encrypt, encryptionKey } from "./crypto";

describe("GitHub refresh-grant encryption", () => {
  it("round trips only with the same user identity", async () => {
    const encoded = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(decodeKey(encoded)).toHaveLength(32);
    const key = await encryptionKey(encoded);
    const sealed = await encrypt(key, 42, "refresh-token");
    await expect(decrypt(key, 42, sealed.iv, sealed.data)).resolves.toBe("refresh-token");
    await expect(decrypt(key, 43, sealed.iv, sealed.data)).rejects.toThrow();
  });

  it("rejects malformed keys", () => expect(() => decodeKey("short")).toThrow());
});
