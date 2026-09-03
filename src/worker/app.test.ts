import { describe, expect, it } from "vitest";
import { appConfigured, verifySignature } from "./app";

async function sign(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

describe("verifySignature", () => {
  it("accepts GitHub's sha256 header and rejects everything else", async () => {
    const body = '{"action":"labeled"}';
    expect(await verifySignature("s3cret", body, await sign("s3cret", body))).toBe(true);
    expect(await verifySignature("s3cret", body, await sign("other", body))).toBe(false);
    expect(await verifySignature("s3cret", `${body} `, await sign("s3cret", body))).toBe(false);
    expect(await verifySignature("s3cret", body, null)).toBe(false);
    expect(await verifySignature("s3cret", body, "sha1=abc")).toBe(false);
  });
});

describe("appConfigured", () => {
  it("needs the id, the private key, and the webhook secret", () => {
    const env = { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "k", GITHUB_APP_WEBHOOK_SECRET: "s" } as unknown as Env;
    expect(appConfigured(env)).toBe(true);
    expect(appConfigured({ ...env, GITHUB_APP_PRIVATE_KEY: "" } as unknown as Env)).toBe(false);
  });
});
