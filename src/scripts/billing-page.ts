const form = document.querySelector<HTMLFormElement>("#billing-form")!;
const account = document.querySelector("#billing-account") as unknown as HTMLSelectElement;
const amount = document.querySelector<HTMLInputElement>("#billing-amount")!;
const status = document.querySelector<HTMLElement>("#billing-status")!;
const balance = document.querySelector<HTMLElement>("#billing-balance")!;
const buy = document.querySelector<HTMLButtonElement>("#billing-buy")!;
const spending = document.querySelector<HTMLFormElement>("#spending-form")!;
const paidEnabled = document.querySelector<HTMLInputElement>("#spending-enabled")!;
const uncapped = document.querySelector<HTMLInputElement>("#spending-uncapped")!;
const limit = document.querySelector<HTMLInputElement>("#spending-limit")!;
let purchaseId = crypto.randomUUID();
let generation = 0;

async function loadBalance() {
  const current = ++generation;
  buy.disabled = true;
  balance.textContent = "";
  spending.hidden = true;
  try {
    const response = await fetch(`/api/billing/${encodeURIComponent(account.value)}`);
    const data = await response.json() as { error?: string; paidMicros: number; promotionalMicros: number; paidEnabled: boolean; paidLimitMicros: number | null };
    if (current !== generation) return;
    if (!response.ok) throw new Error(data.error ?? "Cannot load balance");
    balance.textContent = `Available credit: ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((data.paidMicros + data.promotionalMicros) / 1_000_000)}`;
    paidEnabled.checked = data.paidEnabled;
    uncapped.checked = data.paidLimitMicros === null && data.paidEnabled;
    limit.value = String((data.paidLimitMicros ?? 20_000_000) / 1_000_000);
    limit.disabled = uncapped.checked;
    spending.hidden = false;
    status.textContent = "";
    buy.disabled = false;
  } catch (error) { if (current === generation) status.textContent = error instanceof Error ? error.message : "Cannot load balance"; }
}
uncapped.addEventListener("change", () => { limit.disabled = uncapped.checked; });
spending.addEventListener("submit", async (event) => {
  event.preventDefault();
  const selected = account.value;
  try {
    const response = await fetch(`/api/billing/${encodeURIComponent(selected)}/limits`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: paidEnabled.checked, limitMicros: uncapped.checked ? null : Math.round(Number(limit.value) * 1_000_000) }),
    });
    if (!response.ok) throw new Error("Could not save spending policy");
    if (selected === account.value) await loadBalance();
  } catch (error) { status.textContent = error instanceof Error ? error.message : "Could not save spending policy"; }
});
account.addEventListener("change", () => { purchaseId = crypto.randomUUID(); void loadBalance(); });
amount.addEventListener("change", () => { purchaseId = crypto.randomUUID(); });
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  buy.disabled = true;
  account.disabled = true;
  amount.disabled = true;
  try {
    const response = await fetch(`/api/billing/${encodeURIComponent(account.value)}/checkout`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ purchaseId, cents: Math.round(Number(amount.value) * 100) }),
    });
    const data = await response.json() as { error?: string; url: string };
    if (!response.ok) throw new Error(data.error ?? "Checkout unavailable");
    const url = new URL(data.url);
    if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com") throw new Error("Invalid checkout destination");
    window.location.assign(url.href);
  } catch (error) { status.textContent = error instanceof Error ? error.message : "Checkout unavailable"; buy.disabled = false; }
  finally { account.disabled = false; amount.disabled = false; }
});
void (async () => {
  try {
    const response = await fetch("/api/billing/accounts");
    const data = await response.json() as { error?: string; accounts: { login: string }[] };
    if (!response.ok) throw new Error(response.status === 401 ? "Sign in from the dashboard to manage credit." : data.error ?? "Accounts unavailable");
    for (const item of data.accounts) account.add(new Option(item.login, item.login));
    if (!account.options.length) throw new Error("No accounts available.");
    form.hidden = false;
    await loadBalance();
  } catch (error) { status.textContent = error instanceof Error ? error.message : "Accounts unavailable"; }
})();
export {};
