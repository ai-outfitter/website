import { describe, expect, it, vi } from "vitest";
import { webIdentity } from "./identified-analytics";
import type { AuthState } from "./auth-state";
const signedIn = { status: "signed-in", fetchedAt: 1, index: { user: {}, activeAccount: { login: "team", type: "Organization" }, accounts: [], githubAppSlug: "outfitter" } } as AuthState;
function setup() {
  const client = { identify: vi.fn(), reset: vi.fn(), register: vi.fn(), unregister: vi.fn(), has_opted_out_capturing: vi.fn(() => false) };
  const fetcher = vi.fn(async () => Response.json({ user: { id: "github:42", email: "person@example.com" }, workspaces: [{ id: "org:70", login: "team", type: "Organization" }] }));
  return { client, fetcher };
}
describe("identified website analytics", () => {
  it("uses the same stable identity as CLI and attaches workspace context", async () => {
    const { client, fetcher } = setup();
    await webIdentity(client, fetcher, () => false)(signedIn);
    expect(client.identify).toHaveBeenCalledWith("github:42", { email: "person@example.com" });
    expect(client.register).toHaveBeenCalledWith({ workspace_id: "org:70", workspace_type: "Organization" });
    expect(client.reset.mock.invocationCallOrder[0]).toBeLessThan(client.identify.mock.invocationCallOrder[0]);
  });
  it("honors DNT and SDK opt-out before requesting identity", async () => {
    const { client, fetcher } = setup();
    await webIdentity(client, fetcher, () => true)(signedIn);
    client.has_opted_out_capturing.mockReturnValue(true);
    await webIdentity(client, fetcher, () => false)(signedIn);
    expect(fetcher).not.toHaveBeenCalled();
    expect(client.identify).not.toHaveBeenCalled();
  });
  it("cannot identify a late response after logout", async () => {
    const { client } = setup();
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    const handle = webIdentity(client, fetcher, () => false);
    const waiting = handle(signedIn);
    await handle({ status: "signed-out", fetchedAt: 2 });
    resolve(Response.json({ user: { id: "github:42" }, workspaces: [] }));
    await waiting;
    expect(client.identify).not.toHaveBeenCalled();
    expect(client.reset).toHaveBeenCalled();
  });
  it("keeps analytics failure out of the sign-in flow", async () => {
    const { client } = setup();
    await expect(webIdentity(client, async () => { throw new Error("offline"); }, () => false)(signedIn)).resolves.toBeUndefined();
  });
});
