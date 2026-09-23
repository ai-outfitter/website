const form = document.querySelector<HTMLFormElement>("#billing-form")!;
const account = document.querySelector("#billing-account") as unknown as HTMLSelectElement;
const amount = document.querySelector<HTMLInputElement>("#billing-amount")!;
const status = document.querySelector<HTMLElement>("#billing-status")!;
const balance = document.querySelector<HTMLElement>("#billing-balance")!;
const buy = document.querySelector<HTMLButtonElement>("#billing-buy")!;
let purchaseId = crypto.randomUUID();
let generation = 0;

async function loadBalance() {
  const current = ++generation;
  buy.disabled = true;
  balance.textContent = "";
  try {
    const response = await fetch(`/api/billing/${encodeURIComponent(account.value)}`);
    const data = await response.json() as { error?: string; paidMicros: number };
    if (current !== generation) return;
    if (!response.ok) throw new Error(data.error ?? "Cannot load balance");
    balance.textContent = `Available credit: ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(data.paidMicros / 1_000_000)}`;
    status.textContent = "";
    buy.disabled = false;
  } catch (error) { if (current === generation) status.textContent = error instanceof Error ? error.message : "Cannot load balance"; }
}
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
