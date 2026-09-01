import { dashboardPath, dashboardRoute, workflowManagerPath, type DashboardRoute } from "../dashboard/routes";

type Repository = { fullName: string; defaultBranch: string; private: boolean; canPush: boolean };
type Account = { login: string; type: "User" | "Organization"; installationId: number | null; repository: Repository | null };
type Workflow = {
  id: string;
  title?: string;
  description?: string;
  sourceRepository: string;
  sourceSha: string;
  state: "add" | "installed" | "outdated" | "overridden";
  strategy?: "catalog-reference" | "vendored";
  reason?: string;
};
type Source = {
  id: string;
  section: "sources" | "remote_settings";
  kind: "github" | "uri" | "path" | "invalid";
  location: string;
  github?: string;
  ref?: string;
  path?: string;
  dependencies: string[];
  repositoryUrl?: string;
};
type Configuration = {
  login: string;
  repository: Repository | null;
  repositoryUrl: string;
  settings: { exists: boolean; valid: boolean; error?: string; raw: string; defaults: { agent?: string }; sources: Source[] };
  workflows: Workflow[];
};
type AccountIndex = { user: { name?: string }; activeAccount: Account | null; accounts: Account[]; githubAppSlug: string };
type Freshness = {
  id: string;
  status: "current" | "outdated" | "ahead" | "diverged" | "unpinned" | "unavailable" | "invalid" | "local-only";
  currentRef?: string;
  latestRef?: string;
  latestSha?: string;
  latestKind?: "release" | "default-branch";
  defaultBranch?: string;
  repositoryUrl?: string;
  reason?: string;
};
type PlanChange = { path: string; action: "add" | "update" | "delete"; before: string | null; after: string | null };
type Fetcher = typeof fetch;

function required<T = HTMLElement>(document: Document, id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Dashboard element #${id} is missing`);
  return value as T;
}
function element<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, className?: string) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  return value;
}
function badge(document: Document, value: string) {
  const item = element(document, "span", `badge ${value}`);
  item.textContent = value.replaceAll("-", " ");
  return item;
}
async function api<T>(fetcher: Fetcher, path: string, options?: RequestInit): Promise<T> {
  const response = await fetcher(path, { ...options, headers: { "content-type": "application/json", ...options?.headers } });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `Request failed with status ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return response.json() as Promise<T>;
}

export class DashboardController {
  private index: AccountIndex | null = null;
  private configuration: Configuration | null = null;
  private route: DashboardRoute | null = null;
  private login: string | null = null;
  private planToken: string | null = null;
  private planScope: "workflow" | "source" | null = null;
  private freshness = new Map<string, Freshness>();

  constructor(private readonly document: Document, private readonly fetcher: Fetcher, private readonly location: Location, private readonly history: History) {}

  async start() {
    this.bind();
    this.route = dashboardRoute(new URL(this.location.href).pathname);
    const routeAccount = this.route?.page === "overview" || this.route?.page === "workflow" ? this.route.account : null;
    const prefetched: Promise<Configuration | Error> | null = routeAccount
      ? api<Configuration>(this.fetcher, `/api/accounts/${encodeURIComponent(routeAccount)}/configuration`).catch((error: unknown) => error instanceof Error ? error : new Error("Configuration request failed"))
      : null;
    try { this.index = await api<AccountIndex>(this.fetcher, "/api/accounts"); }
    catch (error) {
      if ((error as { status?: number }).status === 401) {
        required(this.document, "signed-out").hidden = false;
        this.document.dispatchEvent(new CustomEvent("outfitter:signed-out"));
      } else this.showError(error);
      return;
    }
    required<HTMLAnchorElement>(this.document, "install-app").href = `https://github.com/apps/${encodeURIComponent(this.index.githubAppSlug)}/installations/new`;
    const installed = await this.acceptInstallationReturn();
    const requested = routeAccount && this.index.accounts.some((account) => account.login === routeAccount) ? routeAccount : null;
    const login = installed ?? requested ?? this.index.activeAccount?.login ?? this.index.accounts[0]?.login;
    if (!login) {
      required(this.document, "signed-in").hidden = false;
      this.status("Install the GitHub App for your personal account or organization to continue.");
      this.document.dispatchEvent(new CustomEvent("outfitter:account", { detail: this.index }));
      return;
    }
    if (this.index.activeAccount?.login !== login) await this.setActiveAccount(login);
    this.login = login;
    this.canonicalize(login);
    this.document.dispatchEvent(new CustomEvent("outfitter:account", { detail: this.index }));
    const result = requested === login ? await prefetched : null;
    if (result instanceof Error) throw result;
    await this.load(login, result ?? undefined);
  }

  private bind() {
    required<HTMLButtonElement>(this.document, "sign-in").onclick = () => void this.signIn();
    for (const button of this.document.querySelectorAll<HTMLButtonElement>("[data-apply]")) button.onclick = () => void this.apply(button.dataset.apply as "pull-request" | "direct");
  }

  private async signIn() {
    try {
      const callback = new URL(this.location.href);
      const data = await api<{ url: string }>(this.fetcher, "/api/auth/sign-in/social", { method: "POST", body: JSON.stringify({ provider: "github", callbackURL: `${callback.pathname}${callback.search}` }) });
      this.location.assign(data.url);
    } catch (error) { this.showError(error); }
  }

  private async acceptInstallationReturn() {
    if (!this.index) return null;
    const installationId = new URL(this.location.href).searchParams.get("installation_id");
    if (!installationId) return null;
    const account = this.index.accounts.find((candidate) => candidate.installationId !== null && String(candidate.installationId) === installationId);
    if (!account) { this.status("This session cannot access that GitHub App installation."); return null; }
    await this.setActiveAccount(account.login);
    return account.login;
  }

  private canonicalize(login: string) {
    const route = this.route;
    let path = dashboardPath(login);
    if (route?.page === "install" || route?.page === "workflow") path = workflowManagerPath(login, route.workflow);
    this.route = dashboardRoute(path);
    const hash = new URL(this.location.href).hash;
    this.history.replaceState(null, "", `${path}${hash}`);
  }

  private async setActiveAccount(login: string) {
    const response = await api<{ activeAccount: Account }>(this.fetcher, "/api/accounts/active", { method: "PUT", body: JSON.stringify({ login }) });
    if (this.index) this.index.activeAccount = response.activeAccount;
  }

  private async load(login: string, configuration?: Configuration) {
    try {
      this.configuration = configuration ?? await api<Configuration>(this.fetcher, `/api/accounts/${encodeURIComponent(login)}/configuration`);
      const workflowId = this.route?.page === "workflow" ? this.route.workflow : null;
      if (workflowId) this.renderManager(workflowId); else this.renderOverview();
      required(this.document, "signed-in").hidden = false;
      this.status("");
    } catch (error) { this.showError(error); }
  }

  private renderOverview() {
    const data = this.configuration!;
    required(this.document, "dashboard-overview").hidden = false;
    required(this.document, "workflow-manager").hidden = true;
    required(this.document, "configuration-title").textContent = `${data.login}/.agents`;
    const repositoryLink = required<HTMLAnchorElement>(this.document, "repository-link");
    repositoryLink.href = data.repositoryUrl;
    repositoryLink.hidden = !data.repository;
    const summary = required(this.document, "configuration-summary");
    const defaults = element(this.document, "span", "muted");
    defaults.textContent = !data.settings.valid ? data.settings.error ?? "settings.yml is invalid."
      : data.settings.defaults.agent ? `Default agent: ${data.settings.defaults.agent}` : "No default agent is set.";
    summary.replaceChildren(
      badge(this.document, data.repository ? "repository-ready" : "repository-missing"),
      badge(this.document, data.settings.valid ? "valid-settings" : "invalid"),
      defaults,
    );
    const yaml = required(this.document, "settings-yaml");
    yaml.textContent = data.settings.exists ? data.settings.raw : "# settings.yml does not exist\n";
    required<HTMLDetailsElement>(this.document, "settings-details").open = !data.settings.valid;
    this.renderSources();
    this.renderWorkflows();
    if (data.repository) void this.loadFreshness();
  }

  private renderSources() {
    const sources = this.configuration!.settings.sources;
    const direct = sources.filter((source) => source.section === "sources");
    const remote = sources.filter((source) => source.section === "remote_settings");
    this.renderSourceGroup("catalog-sources", direct, "No catalog sources are configured.");
    required(this.document, "remote-source-section").hidden = remote.length === 0;
    this.renderSourceGroup("remote-sources", remote, "");
  }

  private renderSourceGroup(id: string, sources: Source[], emptyText: string) {
    const root = required(this.document, id);
    if (!sources.length) { const empty = element(this.document, "p", "muted"); empty.textContent = emptyText; root.replaceChildren(empty); return; }
    root.replaceChildren(...sources.map((source) => {
      const card = element(this.document, "article", "source-card");
      card.dataset.source = source.id;
      const state = badge(this.document, "checking");
      state.dataset.sourceState = source.id;
      card.appendChild(state);
      const title = element(this.document, "h3");
      if (source.repositoryUrl) { const link = element(this.document, "a"); link.href = source.repositoryUrl; link.textContent = source.location; title.appendChild(link); }
      else title.textContent = source.location;
      card.appendChild(title);
      const metadata = element(this.document, "dl");
      for (const node of [...this.definition("Type", source.kind), ...this.definition("Ref", source.ref ?? "Unpinned"), ...this.definition("Path", source.path ?? "Repository root")]) metadata.appendChild(node);
      const [latestTerm, latestValue] = this.definition("Latest", source.kind === "github" ? "Checking…" : "Not tracked");
      latestValue.dataset.sourceLatest = source.id;
      metadata.appendChild(latestTerm); metadata.appendChild(latestValue);
      card.appendChild(metadata);
      const dependency = element(this.document, "p", "muted");
      if (source.dependencies.length) {
        dependency.append("Used by ");
        source.dependencies.forEach((workflow, index) => {
          if (index) dependency.append(", ");
          const link = element(this.document, "a"); link.href = workflowManagerPath(this.login!, workflow); link.textContent = workflow; dependency.appendChild(link);
        });
      } else dependency.textContent = "No installed workflow depends on this source.";
      card.appendChild(dependency);
      const actions = element(this.document, "div", "actions");
      const update = element(this.document, "button", "button") as HTMLButtonElement;
      update.type = "button"; update.textContent = "Update source"; update.disabled = true; update.dataset.sourceUpdate = source.id; update.onclick = () => void this.previewSource(source.id, "update");
      const remove = element(this.document, "button", "button") as HTMLButtonElement;
      remove.type = "button"; remove.textContent = "Remove source"; remove.disabled = source.dependencies.length > 0; remove.onclick = () => void this.previewSource(source.id, "remove");
      actions.appendChild(update); actions.appendChild(remove); card.appendChild(actions);
      return card;
    }));
  }

  private definition(term: string, value: string) {
    const dt = element(this.document, "dt"); dt.textContent = term;
    const dd = element(this.document, "dd"); dd.textContent = value;
    return [dt, dd] as const;
  }

  private async loadFreshness() {
    try {
      const result = await api<{ sources: Freshness[] }>(this.fetcher, `/api/accounts/${encodeURIComponent(this.login!)}/configuration/freshness`);
      for (const freshness of result.sources) {
        this.freshness.set(freshness.id, freshness);
        const state = [...this.document.querySelectorAll<HTMLElement>("[data-source-state]")].find((element) => element.dataset.sourceState === freshness.id);
        if (state) { state.className = `badge ${freshness.status}`; state.textContent = freshness.status.replaceAll("-", " "); }
        const update = [...this.document.querySelectorAll<HTMLButtonElement>("[data-source-update]")].find((element) => element.dataset.sourceUpdate === freshness.id);
        if (update) update.disabled = !freshness.latestRef || freshness.status === "current" || freshness.status === "unavailable" || freshness.status === "invalid" || freshness.status === "local-only";
        const latest = [...this.document.querySelectorAll<HTMLElement>("[data-source-latest]")].find((element) => element.dataset.sourceLatest === freshness.id);
        if (latest) latest.textContent = freshness.latestRef ? `${freshness.latestRef} · ${freshness.latestKind === "release" ? "release" : "default branch"}` : freshness.reason ?? "Unavailable";
      }
    } catch (error) { this.status(error instanceof Error ? `Source checks failed: ${error.message}` : "Source checks failed."); }
  }

  private renderWorkflows() {
    const workflows = this.configuration!.workflows;
    const order = { overridden: 0, outdated: 1, installed: 2, add: 3 };
    const installed = workflows.filter((workflow) => workflow.state !== "add").sort((left, right) => order[left.state] - order[right.state] || (left.title ?? left.id).localeCompare(right.title ?? right.id));
    const community = workflows.filter((workflow) => workflow.state === "add").sort((left, right) => (left.title ?? left.id).localeCompare(right.title ?? right.id));
    this.renderWorkflowGroup("installed-workflows", installed, "No workflows are installed.");
    this.renderWorkflowGroup("community-workflows", community, "Every community workflow is installed.");
  }

  private renderWorkflowGroup(id: string, workflows: Workflow[], emptyText: string) {
    const root = required(this.document, id);
    if (!workflows.length) { const empty = element(this.document, "p", "muted"); empty.textContent = emptyText; root.replaceChildren(empty); return; }
    root.replaceChildren(...workflows.map((workflow) => {
      const card = element(this.document, "a", "workflow-card") as HTMLAnchorElement;
      card.href = workflowManagerPath(this.login!, workflow.id);
      card.appendChild(badge(this.document, workflow.state));
      const title = element(this.document, "h3"); title.textContent = workflow.title ?? workflow.id;
      const summary = element(this.document, "p"); summary.textContent = workflow.reason ?? workflow.description ?? "";
      card.appendChild(title); card.appendChild(summary);
      return card;
    }));
  }

  private renderManager(workflowId: string) {
    const workflow = this.configuration!.workflows.find((candidate) => candidate.id === workflowId);
    if (!workflow) { this.status("This workflow is not in the current community catalog."); this.renderOverview(); return; }
    required(this.document, "dashboard-overview").hidden = true;
    required(this.document, "workflow-manager").hidden = false;
    required<HTMLAnchorElement>(this.document, "manager-back").href = dashboardPath(this.login!);
    required(this.document, "manager-title").textContent = workflow.title ?? workflow.id;
    const state = required(this.document, "manager-state"); state.className = `badge ${workflow.state}`; state.textContent = workflow.state;
    required(this.document, "manager-description").textContent = workflow.reason ?? workflow.description ?? "";
    const metadata = required(this.document, "manager-metadata");
    metadata.replaceChildren(...this.definition("Source", workflow.sourceRepository), ...this.definition("Revision", workflow.sourceSha), ...this.definition("Repository", `${this.login}/.agents`));
    const strategy = required<HTMLSelectElement>(this.document, "install-strategy");
    strategy.value = workflow.strategy ?? "catalog-reference";
    required(this.document, "repository-options").hidden = Boolean(this.configuration!.repository);
    const actions = required(this.document, "workflow-actions");
    const definitions: Array<{ action: "install" | "update" | "repair" | "remove"; label: string; primary?: boolean }> = workflow.state === "add"
      ? [{ action: "install", label: "Preview installation", primary: true }]
      : workflow.state === "outdated"
        ? [{ action: "update", label: "Preview update", primary: true }, { action: "remove", label: "Preview removal" }]
        : workflow.state === "overridden"
          ? [{ action: "repair", label: "Preview repair", primary: true }, { action: "remove", label: "Preview removal" }]
          : [{ action: "update", label: "Preview strategy change", primary: true }, { action: "remove", label: "Preview removal" }];
    actions.replaceChildren(...definitions.map(({ action, label, primary }) => {
      const button = element(this.document, "button", `button${primary ? " primary" : ""}`) as HTMLButtonElement;
      button.type = "button"; button.textContent = label; button.dataset.workflowAction = action; button.onclick = () => void this.previewWorkflow(workflow, action); return button;
    }));
    if (workflow.state === "installed") {
      const update = actions.querySelector<HTMLButtonElement>('[data-workflow-action="update"]');
      const installedStrategy = workflow.strategy ?? "catalog-reference";
      if (update) update.disabled = true;
      strategy.onchange = () => { if (update) update.disabled = strategy.value === installedStrategy; };
    } else strategy.onchange = null;
  }

  private async previewWorkflow(workflow: Workflow, action: "install" | "update" | "repair" | "remove") {
    const strategy = required<HTMLSelectElement>(this.document, "install-strategy").value;
    await this.preview("workflow", {
      target: "workflow", workflow: workflow.id, action, strategy,
      private: required<HTMLSelectElement>(this.document, "visibility").value === "private",
    });
  }

  private async previewSource(source: string, action: "update" | "remove") {
    await this.preview("source", { target: "source", source, action });
  }

  private async preview(scope: "workflow" | "source", request: Record<string, unknown>) {
    try {
      const result = await api<{ token: string; plan: { baseSha: string | null; changes: PlanChange[] } }>(this.fetcher, `/api/accounts/${encodeURIComponent(this.login!)}/plans`, { method: "POST", body: JSON.stringify(request) });
      this.planToken = result.token; this.planScope = scope;
      const root = required(this.document, `${scope}-preview`);
      const summary = element(this.document, "p"); summary.textContent = `Previewing ${result.plan.changes.length} file change${result.plan.changes.length === 1 ? "" : "s"}.`;
      const details = result.plan.changes.map((change) => {
        const item = element(this.document, "details"); const heading = element(this.document, "summary"); const content = element(this.document, "pre");
        heading.textContent = `${change.action.toUpperCase()} ${change.path}`; content.textContent = change.after ?? "(deleted)"; item.appendChild(heading); item.appendChild(content); return item;
      });
      root.replaceChildren(summary, ...details);
      if (scope === "source") required(this.document, "source-plan").hidden = false;
      const apply = required(this.document, `${scope}-apply-actions`); apply.hidden = false;
      const pr = apply.querySelector<HTMLButtonElement>('[data-apply="pull-request"]');
      const direct = apply.querySelector<HTMLButtonElement>('[data-apply="direct"]');
      if (pr) pr.hidden = result.plan.baseSha === null;
      if (direct) direct.textContent = result.plan.baseSha === null ? "Create repository" : "Commit to default branch";
    } catch (error) { this.planToken = null; this.planScope = null; this.showError(error); }
  }

  private async apply(mode: "pull-request" | "direct") {
    if (!this.planToken || !this.planScope) return this.status("Preview the repository change first.");
    if (!confirm(mode === "direct" ? "Commit these changes to the default branch?" : "Open a pull request with these changes?")) return;
    try {
      const result = await api<{ pullRequestUrl?: string; commitUrl?: string }>(this.fetcher, `/api/accounts/${encodeURIComponent(this.login!)}/plans/apply`, { method: "POST", body: JSON.stringify({ token: this.planToken, mode }) });
      const target = result.pullRequestUrl ?? result.commitUrl;
      if (target) this.location.assign(target);
    } catch (error) { this.showError(error); }
  }

  private status(message: string) { required(this.document, "dashboard-status").textContent = message; }
  private showError(error: unknown) { this.status(error instanceof Error ? error.message : "Unexpected dashboard error"); }
}

export function startDashboard(documentRef: Document = document, fetcher: Fetcher = fetch, locationRef: Location = location, historyRef: History = history) {
  return new DashboardController(documentRef, fetcher, locationRef, historyRef).start();
}
