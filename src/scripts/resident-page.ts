interface ResidentView {
  enrolled: boolean;
  enabled?: boolean;
  state?: "provisioning" | "ready" | "failed" | "disabled";
  projectManagerName?: string;
  engineerName?: string;
  repositories?: { id: number; fullName: string }[];
  agents?: { role: string; name: string; ready: boolean; reason?: string }[];
  reason?: string;
}
interface ResidentOptions {
  repositories: { id: number; fullName: string }[];
  status: ResidentView;
}
export async function startResidentPage(root: Document = document, fetcher: typeof fetch = fetch, location: Pick<Location, "href"> = window.location) {
  const message = root.querySelector<HTMLElement>("#resident-message")!;
  const accounts = root.querySelector("#resident-account") as unknown as HTMLSelectElement;
  const accountPanel = root.querySelector<HTMLElement>("#resident-account-panel")!;
  const form = root.querySelector<HTMLFormElement>("#resident-form")!;
  const manager = root.querySelector<HTMLInputElement>("#resident-manager")!;
  const engineer = root.querySelector<HTMLInputElement>("#resident-engineer")!;
  const repositories = root.querySelector<HTMLElement>("#resident-repositories")!;
  const statusPanel = root.querySelector<HTMLElement>("#resident-status-panel")!;
  const state = root.querySelector<HTMLElement>("#resident-state")!;
  const agents = root.querySelector<HTMLElement>("#resident-agents")!;
  const readiness = root.querySelector<HTMLElement>("#resident-readiness")!;
  const enable = root.querySelector<HTMLButtonElement>("#resident-enable")!;
  const disable = root.querySelector<HTMLButtonElement>("#resident-disable")!;
  const refresh = root.querySelector<HTMLButtonElement>("#resident-refresh")!;
  let generation = 0;
  let canEnroll = false;
  const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Resident service unavailable";
  function busy(value: boolean) { accounts.disabled = value; enable.disabled = value || !canEnroll; disable.disabled = value; refresh.disabled = value; }
  async function api<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetcher(url, init);
    const data = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "Could not load resident settings");
    return data;
  }
  function renderStatus(value: ResidentView) {
    statusPanel.hidden = !value.enrolled;
    disable.hidden = !value.enabled;
    state.textContent = `Residents: ${value.state ?? "not enrolled"}`;
    agents.replaceChildren();
    for (const agent of value.agents ?? []) {
      const item = root.createElement("li");
      item.textContent = `${agent.name} (${agent.role === "project-manager" ? "project manager" : "engineer"}): ${agent.ready ? "ready" : "not ready"}${agent.reason ? ` — ${agent.reason}` : ""}`;
      agents.appendChild(item);
    }
    readiness.textContent = value.reason ?? (value.state === "ready" ? "Ready for new issues in your selected repositories. The engineer remains idle during issue triage." : value.state === "disabled" ? "New triage tasks and resident credentials are disabled. Work already in progress may finish." : "Provisioning may take a few minutes. Refresh to check both residents.");
  }
  async function load() {
    const current = ++generation;
    const selected = accounts.value;
    canEnroll = false; form.hidden = true; statusPanel.hidden = true; message.textContent = "Loading resident settings…";
    try {
      const data = await api<ResidentOptions>(`/api/residents/${encodeURIComponent(selected)}`);
      if (current !== generation || selected !== accounts.value) return;
      manager.value = data.status.projectManagerName ?? "Project Manager";
      engineer.value = data.status.engineerName ?? "Engineer";
      const selectedIds = new Set(data.status.repositories?.map((repo) => repo.id));
      repositories.replaceChildren();
      for (const repo of data.repositories) {
        const label = root.createElement("label"); const checkbox = root.createElement("input");
        checkbox.type = "checkbox"; checkbox.name = "repository"; checkbox.value = String(repo.id); checkbox.checked = selectedIds.has(repo.id);
        label.appendChild(checkbox); label.appendChild(root.createTextNode(repo.fullName)); repositories.appendChild(label);
      }
      form.hidden = false; canEnroll = data.repositories.length > 0; enable.disabled = !canEnroll;
      enable.textContent = data.status.enabled ? "Update issue triage" : "Enable issue triage";
      renderStatus(data.status);
      message.textContent = data.repositories.length ? "" : "No eligible repositories are available. Update the GitHub App's repository access, then refresh.";
    } catch (error) { if (current === generation) { message.textContent = errorMessage(error); disable.hidden = false; } }
  }
  accounts.addEventListener("change", () => { void load(); });
  refresh.addEventListener("click", () => { void load(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const ids = [...repositories.querySelectorAll<HTMLInputElement>('input[name="repository"]:checked')].map((input) => Number(input.value));
    if (!ids.length) { message.textContent = "Select at least one repository."; return; }
    const selected = accounts.value; busy(true); message.textContent = "Saving resident settings…";
    try {
      await api(`/api/residents/${encodeURIComponent(selected)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository_ids: ids, projectManagerName: manager.value.trim(), engineerName: engineer.value.trim() }) });
      await load();
    } catch (error) { message.textContent = errorMessage(error); }
    finally { busy(false); }
  });
  disable.addEventListener("click", async () => {
    busy(true); message.textContent = "Disabling new triage tasks…";
    try { await api(`/api/residents/${encodeURIComponent(accounts.value)}`, { method: "DELETE" }); await load(); disable.hidden = true; message.textContent = "New issue triage is disabled for this account."; }
    catch (error) { message.textContent = errorMessage(error); }
    finally { busy(false); }
  });
  try {
    const response = await fetcher("/api/residents");
    if (response.status === 401) { root.querySelector<HTMLElement>("#resident-sign-in")!.hidden = false; message.textContent = "Sign in to choose your account."; return; }
    const data = await response.json() as { accounts?: { login: string; type: string }[]; activeAccount?: { login: string }; error?: string };
    if (!response.ok) throw new Error(data.error ?? "Could not load your accounts");
    for (const account of data.accounts ?? []) { const option = root.createElement("option"); option.value = account.login; option.textContent = `${account.login} (${account.type === "User" ? "personal" : "organization"})`; accounts.appendChild(option); }
    if (!accounts.options.length) { message.textContent = "No owned GitHub accounts are available."; return; }
    const preferred = new URL(location.href).searchParams.get("account") ?? data.activeAccount?.login;
    if (preferred && [...accounts.options].some((option) => option.value === preferred)) accounts.value = preferred;
    accountPanel.hidden = false;
    await load();
  } catch (error) { message.textContent = errorMessage(error); }
}
