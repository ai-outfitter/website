import { dashboardPath } from "../dashboard/routes";

type Account = {
  login: string;
  type: "User" | "Organization";
  updatedAt?: string;
};

type AccountIndex = {
  user: { name?: string };
  activeAccount: Account | null;
  accounts: Account[];
};

function latestOrganizations(index: AccountIndex) {
  return index.accounts
    .filter((account) => account.type === "Organization")
    .map((account, position) => ({ account, position }))
    .sort((left, right) => {
      const byUpdated = (right.account.updatedAt ?? "").localeCompare(left.account.updatedAt ?? "");
      return byUpdated || left.position - right.position;
    })
    .slice(0, 3)
    .map(({ account }) => account);
}

function renderAccountMenu(document: Document, index: AccountIndex, fetcher: typeof fetch, location: Location) {
  const link = document.querySelector<HTMLAnchorElement>("#site-auth");
  const menu = document.querySelector<HTMLDetailsElement>("#site-account");
  const trigger = document.querySelector<HTMLElement>("#site-account-trigger");
  const options = document.querySelector<HTMLElement>("#site-account-options");
  const signOut = document.querySelector<HTMLButtonElement>("#site-sign-out");
  if (!link || !menu || !trigger || !options || !signOut) return;
  const account = index.activeAccount;
  if (!account) return;

  link.hidden = true;
  menu.hidden = false;
  trigger.textContent = account.login;
  trigger.setAttribute("aria-label", `Active ${account.type === "Organization" ? "organization" : "account"}: ${account.login}`);
  options.replaceChildren(...latestOrganizations(index).map((organization) => {
    const option = document.createElement("a");
    option.href = dashboardPath(organization.login);
    option.textContent = organization.login;
    if (organization.login === account.login) option.setAttribute("aria-current", "page");
    option.onclick = async (event) => {
      event.preventDefault();
      if (organization.login !== account.login) {
        await fetcher("/api/accounts/active", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ login: organization.login }),
        });
      }
      location.assign(option.href);
    };
    return option;
  }));
  signOut.onclick = async () => {
    await fetcher("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" } });
    location.reload();
  };
}

export async function startSiteAuth(
  document: Document = window.document,
  fetcher: typeof fetch = fetch,
  location: Location = window.location,
) {
  if (document.querySelector("[data-dashboard]")) {
    document.addEventListener("outfitter:account", (event) => {
      renderAccountMenu(document, (event as CustomEvent<AccountIndex>).detail, fetcher, location);
    }, { once: true });
    return;
  }
  const response = await fetcher("/api/accounts", { headers: { accept: "application/json" } }).catch(() => null);
  if (!response?.ok) return;
  renderAccountMenu(document, await response.json() as AccountIndex, fetcher, location);
}
