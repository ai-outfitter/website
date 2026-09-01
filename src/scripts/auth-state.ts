export type Account = {
  login: string;
  type: "User" | "Organization";
  updatedAt?: string;
  installationId?: number | null;
  repository?: unknown;
};

export type AccountIndex = {
  user: { name?: string };
  activeAccount: Account | null;
  accounts: Account[];
  githubAppSlug: string;
};

export type AuthState =
  | { status: "signed-in"; index: AccountIndex; fetchedAt: number }
  | { status: "signed-out"; fetchedAt: number };

const STORAGE_KEY = "ai-outfitter:auth-navigation:v1";
export const AUTH_REVALIDATE_MS = 60_000;
export const AUTH_MAX_AGE_MS = 300_000;

let memoryState: AuthState | null = null;
let generation = 0;
let pending: { generation: number; id: symbol; promise: Promise<AuthState>; controller: AbortController } | null = null;

function abortError() {
  return new DOMException("Authentication request was cancelled", "AbortError");
}

function storageForWindow(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

function isIndex(value: unknown): value is AccountIndex {
  if (!value || typeof value !== "object") return false;
  const index = value as Partial<AccountIndex>;
  return Boolean(index.user && typeof index.user === "object"
    && (index.activeAccount === null || Boolean(index.activeAccount && typeof index.activeAccount.login === "string"))
    && Array.isArray(index.accounts)
    && index.accounts.every((account) => account && typeof account.login === "string" && (account.type === "User" || account.type === "Organization"))
    && typeof index.githubAppSlug === "string");
}

function isState(value: unknown, now: number): value is AuthState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<AuthState>;
  if (typeof state.fetchedAt !== "number" || now - state.fetchedAt > AUTH_MAX_AGE_MS || state.fetchedAt > now) return false;
  return state.status === "signed-out" || (state.status === "signed-in" && isIndex((state as { index?: unknown }).index));
}

function persist(state: AuthState, storage: Storage | null) {
  memoryState = state;
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* Navigation can work without storage. */ }
}

export function cachedAuthState(storage: Storage | null = storageForWindow(), now = Date.now()): AuthState | null {
  if (isState(memoryState, now)) return memoryState;
  memoryState = null;
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const state: unknown = raw ? JSON.parse(raw) : null;
    if (isState(state, now)) return (memoryState = state);
    if (raw) storage?.removeItem(STORAGE_KEY);
  } catch {
    try { storage?.removeItem(STORAGE_KEY); } catch { /* Ignore unavailable storage. */ }
  }
  return null;
}

export async function resolveAuthState(
  fetcher: typeof fetch = fetch,
  storage: Storage | null = storageForWindow(),
  now = Date.now(),
  force = false,
): Promise<AuthState> {
  const cached = cachedAuthState(storage, now);
  if (!force && cached && now - cached.fetchedAt < AUTH_REVALIDATE_MS) return cached;
  if (pending?.generation === generation) return pending.promise;
  const requestGeneration = generation;
  const requestId = Symbol("auth-request");
  const controller = new AbortController();
  const promise = (async () => {
    try {
      const response = await fetcher("/api/accounts", { headers: { accept: "application/json" }, signal: controller.signal });
      if (generation !== requestGeneration || controller.signal.aborted) throw abortError();
      if (response.status === 401) {
        const state: AuthState = { status: "signed-out", fetchedAt: now };
        persist(state, storage);
        return state;
      }
      if (!response.ok) throw new Error(`Account request failed with status ${response.status}`);
      const index: unknown = await response.json();
      if (generation !== requestGeneration || controller.signal.aborted) throw abortError();
      if (!isIndex(index)) throw new Error("Account response is invalid");
      const state: AuthState = { status: "signed-in", index, fetchedAt: now };
      persist(state, storage);
      return state;
    } catch (error) {
      if (generation !== requestGeneration || controller.signal.aborted || (error as { name?: string }).name === "AbortError") throw abortError();
      if (cached) return cached;
      throw error;
    } finally {
      if (pending?.id === requestId) pending = null;
    }
  })();
  pending = { generation: requestGeneration, id: requestId, promise, controller };
  return promise;
}

export function updateCachedAccountIndex(index: AccountIndex, storage: Storage | null = storageForWindow(), now = Date.now()) {
  const current = cachedAuthState(storage, now);
  const state: AuthState = { status: "signed-in", index, fetchedAt: current?.status === "signed-in" ? current.fetchedAt : now };
  persist(state, storage);
  return state;
}

export function clearCachedAuthState(storage: Storage | null = storageForWindow()) {
  generation += 1;
  pending?.controller.abort();
  memoryState = null;
  pending = null;
  try { storage?.removeItem(STORAGE_KEY); } catch { /* Ignore unavailable storage. */ }
}

export function resetAuthStateForTests() {
  generation += 1;
  pending?.controller.abort();
  memoryState = null;
  pending = null;
}
