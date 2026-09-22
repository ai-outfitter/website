// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startResidentPage } from "./resident-page";
const fixture = `<p id="resident-message"></p><p id="resident-sign-in" hidden></p><section id="resident-account-panel" hidden><select id="resident-account"></select><form id="resident-form" hidden><input id="resident-manager"><input id="resident-engineer"><div id="resident-repositories"></div><button id="resident-enable"></button></form><section id="resident-status-panel" hidden><h2 id="resident-state"></h2><ul id="resident-agents"></ul><p id="resident-readiness"></p></section><button id="resident-refresh"></button><button id="resident-disable" hidden></button></section>`;
const options = { repositories: [{ id: 101, fullName: "team/app" }], status: { enrolled: false } };
const accounts = { accounts: [{ login: "team", type: "Organization" }, { login: "personal", type: "User" }], activeAccount: { login: "team" } };
const node = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
beforeEach(() => { document.body.innerHTML = fixture; });
describe("resident onboarding", () => {
  it("keeps configuration hidden and offers sign-in when logged out", async () => {
    await startResidentPage(document, vi.fn(async () => Response.json({}, { status: 401 })), { href: "https://outfitter/residents/" });
    expect(node("resident-sign-in").hidden).toBe(false); expect(node("resident-form").hidden).toBe(true);
  });
  it("submits only selected repository IDs and display names for the chosen account", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => String(url) === "/api/residents" ? Response.json(accounts) : init?.method === "PUT" ? Response.json({ state: "provisioning" }, { status: 202 }) : Response.json(options));
    await startResidentPage(document, fetcher, { href: "https://outfitter/residents/" });
    node<HTMLInputElement>("resident-manager").value = "Mira"; node<HTMLInputElement>("resident-engineer").value = "Eli";
    document.querySelector<HTMLInputElement>('input[name="repository"]')!.checked = true;
    node("resident-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true));
    const call = fetcher.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(call[0]).toBe("/api/residents/team"); expect(JSON.parse(String(call[1]?.body))).toEqual({ repository_ids: [101], projectManagerName: "Mira", engineerName: "Eli" });
  });
  it("requires a selected repository and does not send an empty enrollment", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => Response.json(String(url) === "/api/residents" ? accounts : options));
    await startResidentPage(document, fetcher, { href: "https://outfitter/residents/" });
    node("resident-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(node("resident-message").textContent).toContain("Select at least one"); expect(fetcher.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });
  it("shows disabled-feature failures while keeping owner revocation available", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => String(url) === "/api/residents" ? Response.json(accounts) : init?.method === "DELETE" ? Response.json({ enabled: false }) : Response.json({ error: "Resident triage is not enabled yet" }, { status: 503 }));
    await startResidentPage(document, fetcher, { href: "https://outfitter/residents/" });
    expect(node("resident-form").hidden).toBe(true); expect(node("resident-message").textContent).toContain("not enabled"); expect(node("resident-disable").hidden).toBe(false);
    node<HTMLButtonElement>("resident-disable").click();
    await vi.waitFor(() => expect(fetcher.mock.calls.some(([url, init]) => url === "/api/residents/team" && init?.method === "DELETE")).toBe(true));
  });
  it("allows an uninstalled owner account to revoke its enrollment", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => String(url) === "/api/residents" ? Response.json({ accounts: [{ login: "uninstalled", type: "Organization" }] }) : init?.method === "DELETE" ? Response.json({ enabled: false }) : Response.json({ error: "Install the Outfitter GitHub App for this account first" }, { status: 403 }));
    await startResidentPage(document, fetcher, { href: "https://outfitter/residents/" });
    expect(node("resident-account").textContent).toContain("uninstalled");
    expect(node("resident-disable").hidden).toBe(false);
    node<HTMLButtonElement>("resident-disable").click();
    await vi.waitFor(() => expect(node("resident-message").textContent).toContain("New issue triage is disabled"));
    expect(fetcher.mock.calls.some(([url, init]) => url === "/api/residents/uninstalled" && init?.method === "DELETE")).toBe(true);
  });
  it("shows independent readiness without treating provisioning as ready", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => Response.json(String(url) === "/api/residents" ? accounts : { ...options, status: { enrolled: true, enabled: true, state: "provisioning", agents: [{ role: "project-manager", name: "Mira", ready: false }, { role: "engineer", name: "Eli", ready: true }] } }));
    await startResidentPage(document, fetcher, { href: "https://outfitter/residents/" });
    expect(node("resident-state").textContent).toContain("provisioning"); expect(node("resident-agents").textContent).toContain("Mira (project manager): not ready"); expect(node("resident-readiness").textContent).toContain("Refresh");
  });
  it("ignores a stale settings response after switching accounts", async () => {
    let slow = false; let resolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === "/api/residents") return Response.json(accounts);
      if (String(url) === "/api/residents/team" && slow) return new Promise((done) => { resolve = done; });
      return Response.json({ repositories: [{ id: 202, fullName: "personal/own" }], status: { enrolled: false } });
    });
    await startResidentPage(document, fetcher, { href: "https://outfitter/residents/" }); slow = true;
    node<HTMLButtonElement>("resident-refresh").click(); (document.querySelector("#resident-account") as unknown as HTMLSelectElement).value = "personal"; node("resident-account").dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(node("resident-repositories").textContent).toContain("personal/own"));
    resolve(Response.json(options)); await new Promise((done) => setTimeout(done, 0));
    expect(node("resident-repositories").textContent).not.toContain("team/app");
  });
});
