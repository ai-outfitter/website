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
const topupForm = document.querySelector<HTMLFormElement>("#topup-form")!;
const topupStatus = document.querySelector<HTMLElement>("#topup-status")!;
const topupThreshold = document.querySelector<HTMLInputElement>("#topup-threshold")!;
const topupAmount = document.querySelector<HTMLInputElement>("#topup-amount")!;
const topupConsent = document.querySelector<HTMLInputElement>("#topup-consent")!;
const topupSave = document.querySelector<HTMLButtonElement>("#topup-save")!;
const topupDisable = document.querySelector<HTMLButtonElement>("#topup-disable")!;
const topupReconcile = document.querySelector<HTMLButtonElement>("#topup-reconcile")!;
let purchaseId = crypto.randomUUID();
let generation = 0;

async function loadBalance() {
  const current = ++generation;
  buy.disabled = true;
  balance.textContent = "";
  spending.hidden = true;
  topupForm.hidden = true;
  topupConsent.checked = false;
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
    await loadTopups(current);
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
async function loadTopups(current = generation) {
  const response = await fetch(`/api/billing/${encodeURIComponent(account.value)}/topups`);
  const data = await response.json() as { featureEnabled: boolean; enabled: boolean; status: string; thresholdCents: number; amountCents: number; pending: boolean };
  if (current !== generation || !response.ok) return;
  topupForm.hidden = false;
  topupThreshold.value = String(data.thresholdCents / 100);
  topupAmount.value = String(data.amountCents / 100);
  topupSave.disabled = !data.featureEnabled || data.pending;
  topupReconcile.hidden = !data.pending;
  const messages: Record<string, string> = {
    ready: "Automatic purchases enabled.", disabled: "Automatic purchases disabled.",
    setup_required: "Finish saving a card, then confirm setup here.",
    payment_failed: "Card declined. Automatic purchases paused. Save another card or buy credit manually above.",
    authentication_required: "Your bank requires authentication. Automatic purchases paused. Save your card again with Stripe or buy credit manually above.",
    pending: "Payment pending. No credit is added until Stripe confirms success.",
    reconciliation_required: "Payment outcome unresolved. Further automatic charges are blocked. Check the pending payment or contact support.",
  };
  topupStatus.textContent = data.featureEnabled ? messages[data.status] ?? "Check your payment status." : "Automatic purchases are not open yet.";
}
async function topupAction(suffix: string, method: string, body?: unknown) {
  const selected = account.value;
  const response = await fetch(`/api/billing/${encodeURIComponent(selected)}/topups${suffix}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json() as { error?: string; url?: string };
  if (!response.ok) throw new Error(data.error ?? "Automatic purchase settings unavailable");
  return { data, selected };
}
topupForm.addEventListener("submit", async (event) => {
  event.preventDefault(); topupSave.disabled = true; account.disabled = true;
  try {
    const { data } = await topupAction("/setup", "POST", { thresholdCents: Math.round(Number(topupThreshold.value) * 100), amountCents: Math.round(Number(topupAmount.value) * 100), consent: topupConsent.checked });
    const url = new URL(data.url!);
    if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com") throw new Error("Invalid checkout destination");
    window.location.assign(url.href);
  } catch (error) { topupStatus.textContent = error instanceof Error ? error.message : "Card setup unavailable"; topupSave.disabled = false; }
  finally { account.disabled = false; }
});
topupDisable.addEventListener("click", async () => {
  try { await topupAction("", "DELETE"); await loadBalance(); }
  catch { topupStatus.textContent = "Could not disable automatic purchases. Try again."; }
});
topupReconcile.addEventListener("click", async () => {
  try { await topupAction("/reconcile", "POST"); await loadBalance(); }
  catch { topupStatus.textContent = "Payment reconciliation unavailable. Try again."; }
});
// A Stripe redirect is a hint only. The server fetches the completed SetupIntent.
const returnedSetup = new URLSearchParams(window.location.search).get("topup_setup");
if (returnedSetup) {
  const confirm = document.createElement("button"); confirm.type = "button";
  confirm.textContent = "Verify saved card for selected account";
  topupForm.appendChild(confirm);
  confirm.onclick = async () => {
    try { await topupAction("/confirm", "POST", { session: returnedSetup }); confirm.remove(); history.replaceState(null, "", "/billing/"); await loadBalance(); }
    catch { topupStatus.textContent = "Card setup is incomplete, revoked, or belongs to another account. Select its account and try again."; }
  };
}
export {};
