import type { AuthState } from "./auth-state";

export type AnalyticsIdentityClient = {
  identify(id: string, properties: Record<string, unknown>): void;
  register(properties: Record<string, unknown>): void;
  unregister(key: string): void;
  reset(): void;
  has_opted_out_capturing(): unknown;
};

/** Auth responses may race account switching or logout; only the newest can identify. */
export function webIdentity(client: AnalyticsIdentityClient, fetcher: typeof fetch, doNotTrack: () => boolean) {
  let generation = 0;
  let identified: string | null = null;
  let pending: AbortController | undefined;
  return async (state: AuthState) => {
    const current = ++generation;
    pending?.abort();
    const reset = () => {
      client.reset();
      client.unregister("workspace_id");
      client.unregister("workspace_type");
      identified = null;
    };
    if (state.status === "signed-out") { reset(); return; }
    if (doNotTrack() || client.has_opted_out_capturing() === true) return;
    const controller = new AbortController();
    pending = controller;
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetcher("/api/cli/identity", { signal: controller.signal, credentials: "same-origin", redirect: "error" });
      const data = await response.json() as { user?: { id?: unknown; email?: unknown }; workspaces?: { id: string; login: string; type: string }[] };
      if (current !== generation || controller.signal.aborted) return;
      if (!response.ok) { if (response.status === 401) reset(); return; }
      if (typeof data.user?.id !== "string" || !/^github:[1-9]\d*$/.test(data.user.id)) return;
      if (doNotTrack() || client.has_opted_out_capturing() === true) return;
      // Reset before first identification too: an earlier page could have another logged-in user.
      if (identified !== data.user.id) reset();
      client.identify(data.user.id, typeof data.user.email === "string" ? { email: data.user.email } : {});
      identified = data.user.id;
      client.unregister("workspace_id");
      client.unregister("workspace_type");
      const workspace = data.workspaces?.find((item) => item.login === state.index.activeAccount?.login);
      if (workspace) client.register({ workspace_id: workspace.id, workspace_type: workspace.type });
    } catch { /* Analytics never blocks authentication or page use. */ }
    finally { clearTimeout(timeout); }
  };
}
