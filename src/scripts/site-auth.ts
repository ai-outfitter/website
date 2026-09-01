import { dashboardPathForRoute, dashboardRoute } from "../dashboard/routes";
import {
  cachedAuthState,
  clearCachedAuthState,
  resolveAuthState,
  updateCachedAccountIndex,
  AUTH_MAX_AGE_MS,
  AUTH_REVALIDATE_MS,
  type AccountIndex,
  type AuthState,
} from "./auth-state";

export const AUTH_STATE_EVENT = "outfitter:auth-state";

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

function elements(document: Document) {
  return {
    loading: document.querySelector<HTMLElement>("#site-auth-loading"),
    link: document.querySelector<HTMLAnchorElement>("#site-auth"),
    menu: document.querySelector<HTMLDetailsElement>("#site-account"),
    trigger: document.querySelector<HTMLElement>("#site-account-trigger"),
    options: document.querySelector<HTMLElement>("#site-account-options"),
    addOrganization: document.querySelector<HTMLAnchorElement>("#site-add-organization"),
    signOut: document.querySelector<HTMLButtonElement>("#site-sign-out"),
  };
}

function renderSignIn(document: Document) {
  const { loading, link, menu } = elements(document);
  if (loading) loading.hidden = true;
  if (link) link.hidden = false;
  if (menu) menu.hidden = true;
}

function renderLoading(document: Document) {
  const { loading, link, menu } = elements(document);
  if (loading) loading.hidden = false;
  if (link) link.hidden = true;
  if (menu) menu.hidden = true;
}

function renderAccountMenu(document: Document, index: AccountIndex, fetcher: typeof fetch, location: Location) {
  const { loading, link, menu, trigger, options, addOrganization, signOut } = elements(document);
  if (!link || !menu || !trigger || !options || !addOrganization || !signOut) return;
  if (loading) loading.hidden = true;
  link.hidden = true;
  menu.hidden = false;
  const account = index.activeAccount;
  trigger.textContent = account?.login ?? index.user.name ?? "Account";
  trigger.setAttribute("aria-label", account
    ? `Active ${account.type === "Organization" ? "organization" : "account"}: ${account.login}`
    : "GitHub account options");
  addOrganization.href = `https://github.com/apps/${encodeURIComponent(index.githubAppSlug)}/installations/new`;
  const route = dashboardRoute(location.pathname || "/");
  options.replaceChildren(...latestOrganizations(index).map((organization) => {
    const option = document.createElement("a");
    option.href = dashboardPathForRoute(organization.login, route);
    option.textContent = organization.login;
    if (organization.login === account?.login) option.setAttribute("aria-current", "page");
    option.onclick = async (event) => {
      event.preventDefault();
      if (organization.login !== account?.login) {
        const response = await fetcher("/api/accounts/active", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ login: organization.login }),
        });
        if (response.ok) {
          const body = await response.json() as { activeAccount?: AccountIndex["activeAccount"] };
          index.activeAccount = body.activeAccount ?? organization;
          publishAuthState(document, updateCachedAccountIndex(index));
        }
      }
      location.assign(option.href);
    };
    return option;
  }));
  signOut.onclick = async () => {
    await fetcher("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" } });
    clearCachedAuthState();
    location.reload();
  };
}

export function publishAuthState(document: Document, state: AuthState) {
  document.dispatchEvent(new CustomEvent<AuthState>(AUTH_STATE_EVENT, { detail: state }));
}

export async function startSiteAuth(
  document: Document = window.document,
  fetcher: typeof fetch = fetch,
  location: Location = window.location,
  scheduleRevalidation = true,
) {
  const render = (state: AuthState) => state.status === "signed-in"
    ? renderAccountMenu(document, state.index, fetcher, location)
    : renderSignIn(document);
  let timer: number | undefined;
  const schedule = (state: AuthState, failedAttempts = 0) => {
    if (!scheduleRevalidation || typeof window === "undefined") return;
    if (timer !== undefined) window.clearTimeout(timer);
    const age = Date.now() - state.fetchedAt;
    const retryDelay = Math.min(30_000 * (2 ** Math.max(0, failedAttempts - 1)), 300_000);
    const untilExpiry = AUTH_MAX_AGE_MS - age;
    const delay = failedAttempts
      ? state.status === "signed-in" && untilExpiry >= 0 ? Math.min(retryDelay, untilExpiry + 1) : retryDelay
      : Math.max(0, AUTH_REVALIDATE_MS - age);
    timer = window.setTimeout(async () => {
      try {
        const refreshed = await resolveAuthState(fetcher, undefined, Date.now(), true);
        render(refreshed);
        schedule(refreshed, refreshed.fetchedAt === state.fetchedAt ? failedAttempts + 1 : 0);
      } catch {
        const now = Date.now();
        const current = cachedAuthState(undefined, now);
        if (!current && state.status === "signed-in" && now - state.fetchedAt > AUTH_MAX_AGE_MS) renderLoading(document);
        schedule(current ?? state, failedAttempts + 1);
      }
    }, delay);
  };
  document.addEventListener(AUTH_STATE_EVENT, (event) => {
    const state = (event as CustomEvent<AuthState>).detail;
    render(state);
    schedule(state);
  });
  const cached = cachedAuthState();
  if (cached) { render(cached); schedule(cached); }
  try {
    const resolved = await resolveAuthState(fetcher);
    render(resolved);
    schedule(resolved);
    return resolved;
  } catch {
    // Keep a neutral loading state when authentication could not be determined.
    return null;
  }
}
