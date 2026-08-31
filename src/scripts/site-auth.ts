type AccountIndex = {
  user: { name?: string };
  activeAccount: { login: string; type: "User" | "Organization" } | null;
};

function renderAuthLink(document: Document, index: AccountIndex) {
  const link = document.querySelector<HTMLAnchorElement>("#site-auth");
  if (!link) return;
  const account = index.activeAccount;
  link.textContent = account?.login ?? index.user.name ?? "Account";
  link.href = account ? `/dashboard/?account=${encodeURIComponent(account.login)}` : "/dashboard/";
  link.setAttribute("aria-label", account
    ? `Manage ${account.type === "Organization" ? "organization" : "user"} ${account.login}`
    : "Open your AI Outfitter account");
}

export async function startSiteAuth(document: Document = window.document, fetcher: typeof fetch = fetch) {
  document.addEventListener("outfitter:account", (event) => {
    renderAuthLink(document, (event as CustomEvent<AccountIndex>).detail);
  }, { once: true });

  if (document.querySelector("[data-dashboard]")) return;
  const response = await fetcher("/api/accounts", { headers: { accept: "application/json" } }).catch(() => null);
  if (!response?.ok) return;
  renderAuthLink(document, await response.json() as AccountIndex);
}
