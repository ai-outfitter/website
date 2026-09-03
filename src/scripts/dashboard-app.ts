import { dashboardPath, dashboardRoute, startPath, workflowManagerPath, type DashboardRoute } from "../dashboard/routes";
import { cachedAuthState, clearCachedAuthState, resolveAuthState, updateCachedAccountIndex, type AccountIndex } from "./auth-state";
import { publishAuthState } from "./site-auth";
import { renderWorkflowDiagram, type WorkflowDiagramNode } from "./workflow-diagram";

type Repository = { fullName: string; defaultBranch: string; private: boolean; canPush: boolean; headSha?: string };
type Playground = {
  repository: { fullName: string; url: string; defaultBranch: string; created: boolean };
  issue: { number: number; url: string; title: string; created: boolean };
};
const ONBOARDING_CHOICES: Array<{ id: string; note: string; recommended?: boolean }> = [
  { id: "engineer", note: "Local agent, implementer subagent in a worktree, draft pull request, CI, formal adversarial review.", recommended: true },
  { id: "software-factory", note: "Resident agents implement typed issues, review, and merge without a workstation." },
  { id: "founder", note: "Plan and scope work into typed issues before any implementation." },
];
const PLAYGROUND_REPOSITORY = "outfitter-playground";
type Account = { login: string; type: "User" | "Organization"; installationId: number | null; repository: Repository | null };
type Workflow = {
  id: string;
  title?: string;
  description?: string;
  sourceRepository: string;
  sourceSha: string;
  state: "available" | "enabled" | "customized" | "needs-attention";
  reason?: string;
  components?: Array<{ type: string; component: string; origin: string }>;
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
  settings: { exists: boolean; valid: boolean; error?: string; raw: string; defaults: { agent?: string }; sources: Source[]; workflows: string[] };
  workflows: Workflow[];
};
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
type WorkflowGraph = {
  title: string;
  source: string;
  nodes: WorkflowDiagramNode[];
  configuration?: Array<{ label: string; items: string[] }>;
};
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
  private onboarding: { workflow: string; planToken: string | null; headSha: string | null; playground: Playground | null } = { workflow: "engineer", planToken: null, headSha: null, playground: null };
  private readonly abort = new AbortController();

  constructor(private readonly document: Document, private readonly fetcher: Fetcher, private readonly location: Location, private readonly history: History) {}

  async start() {
    this.bind();
    const currentUrl = new URL(this.location.href);
    this.route = dashboardRoute(currentUrl.pathname);
    const routeAccount = this.route?.page === "overview" || this.route?.page === "workflow" || this.route?.page === "start" ? this.route.account : null;
    const prefetched: Promise<Configuration | Error> | null = routeAccount
      ? this.request<Configuration>(`/api/accounts/${encodeURIComponent(routeAccount)}/configuration`).catch((error: unknown) => error instanceof Error ? error : new Error("Configuration request failed"))
      : null;
    try {
      // A GitHub sign-in returns to this static page in the same browser tab,
      // so a recent signed-out navigation snapshot must not mask the new cookie.
      const forceAccounts = currentUrl.searchParams.has("installation_id") || cachedAuthState()?.status === "signed-out";
      const auth = await resolveAuthState(this.fetcher, undefined, Date.now(), forceAccounts);
      if (!this.active()) return;
      if (auth.status === "signed-out") return this.signedOut();
      this.index = auth.index;
      const installed = await this.acceptInstallationReturn();
      if (!this.active()) return;
      const requested = routeAccount && this.index.accounts.some((account) => account.login === routeAccount) ? routeAccount : null;
      const login = installed ?? requested ?? this.index.activeAccount?.login ?? this.index.accounts[0]?.login;
      if (!login) {
        required(this.document, "signed-in").hidden = false;
        this.status("Install the GitHub App for your personal account or organization to continue.");
        publishAuthState(this.document, updateCachedAccountIndex(this.index));
        return;
      }
      if (this.index.activeAccount?.login !== login) {
        await this.setActiveAccount(login);
        if (!this.active()) return;
      }
      this.login = login;
      this.canonicalize(login);
      publishAuthState(this.document, updateCachedAccountIndex(this.index));
      const result = requested === login ? await prefetched : null;
      if (!this.active()) return;
      if (result instanceof Error) {
        if ((result as { status?: number }).status === 401) return this.signedOut();
        throw result;
      }
      await this.load(login, result ?? undefined);
    } catch (error) {
      if (this.active() && (error as { name?: string }).name !== "AbortError") this.showError(error);
    }
  }

  dispose() { this.abort.abort(); }

  private active() { return !this.abort.signal.aborted; }

  private request<T>(path: string, options?: RequestInit) {
    return api<T>(this.fetcher, path, { ...options, signal: this.abort.signal });
  }

  private signedOut() {
    if (!this.active()) return;
    clearCachedAuthState();
    required(this.document, "signed-in").hidden = true;
    required(this.document, "signed-out").hidden = false;
    publishAuthState(this.document, { status: "signed-out", fetchedAt: Date.now() });
  }

  private bind() {
    required<HTMLButtonElement>(this.document, "sign-in").onclick = () => void this.signIn();
    for (const button of this.document.querySelectorAll<HTMLButtonElement>("[data-apply]")) button.onclick = () => void this.apply(button.dataset.apply as "pull-request" | "direct");
    required<HTMLButtonElement>(this.document, "onboarding-preview").onclick = () => void this.onboardingPreview();
    required<HTMLButtonElement>(this.document, "onboarding-apply").onclick = () => void this.onboardingApply();
    required<HTMLButtonElement>(this.document, "onboarding-playground").onclick = () => void this.onboardingPlayground();
    required<HTMLButtonElement>(this.document, "onboarding-copy").onclick = () => void this.copyCommands();
  }

  private async signIn() {
    try {
      const callback = new URL(this.location.href);
      const data = await this.request<{ url: string }>("/api/auth/sign-in/social", { method: "POST", body: JSON.stringify({ provider: "github", callbackURL: `${callback.pathname}${callback.search}` }) });
      if (!this.active()) return;
      this.location.assign(data.url);
    } catch (error) { if (this.active() && (error as { name?: string }).name !== "AbortError") this.showError(error); }
  }

  private async acceptInstallationReturn() {
    if (!this.index) return null;
    const installationId = new URL(this.location.href).searchParams.get("installation_id");
    if (!installationId) return null;
    const account = this.index.accounts.find((candidate) => candidate.installationId !== null && String(candidate.installationId) === installationId);
    if (!account) { this.status("This session cannot access that GitHub App installation."); return null; }
    await this.setActiveAccount(account.login);
    if (!this.active()) return null;
    return account.login;
  }

  private canonicalize(login: string) {
    if (!this.active()) return;
    const route = this.route;
    let path = dashboardPath(login);
    if (route?.page === "install" || route?.page === "workflow") path = workflowManagerPath(login, route.workflow);
    if (route?.page === "start") path = startPath(login);
    this.route = dashboardRoute(path);
    const hash = new URL(this.location.href).hash;
    this.history.replaceState(null, "", `${path}${hash}`);
  }

  private async setActiveAccount(login: string) {
    const response = await this.request<{ activeAccount: Account }>("/api/accounts/active", { method: "PUT", body: JSON.stringify({ login }) });
    if (this.active() && this.index) {
      this.index.activeAccount = response.activeAccount;
      publishAuthState(this.document, updateCachedAccountIndex(this.index));
    }
  }

  private async load(login: string, configuration?: Configuration) {
    try {
      const loaded = configuration ?? await this.request<Configuration>(`/api/accounts/${encodeURIComponent(login)}/configuration`);
      if (!this.active()) return;
      this.configuration = loaded;
      const workflowId = this.route?.page === "workflow" ? this.route.workflow : null;
      if (!loaded.repository && (this.route?.page === "overview" || this.route?.page === "entry")) {
        this.route = dashboardRoute(startPath(login));
        this.history.replaceState(null, "", startPath(login));
      }
      if (workflowId) this.renderManager(workflowId);
      else if (this.route?.page === "start") await this.renderOnboarding();
      else this.renderOverview();
      required(this.document, "signed-in").hidden = false;
      this.status("");
    } catch (error) {
      if (!this.active() || (error as { name?: string }).name === "AbortError") return;
      if ((error as { status?: number }).status === 401) this.signedOut();
      else this.showError(error);
    }
  }

  private renderOverview() {
    const data = this.configuration!;
    required(this.document, "dashboard-overview").hidden = false;
    required(this.document, "workflow-manager").hidden = true;
    required(this.document, "onboarding").hidden = true;
    required(this.document, "overview-start").hidden = Boolean(data.repository);
    required<HTMLAnchorElement>(this.document, "overview-start-link").href = startPath(this.login!);
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
    const wrapper = element(this.document, "div", "source-table-wrap");
    const table = element(this.document, "table", "source-table");
    const head = element(this.document, "thead");
    const header = element(this.document, "tr");
    for (const label of ["Source", "Ref", "Used by", "Actions"]) {
      const cell = element(this.document, "th");
      cell.scope = "col";
      cell.textContent = label;
      header.appendChild(cell);
    }
    head.appendChild(header);
    const body = element(this.document, "tbody");
    for (const source of sources) {
      const row = element(this.document, "tr");
      row.dataset.source = source.id;

      const sourceCell = element(this.document, "td");
      sourceCell.dataset.label = "Source";
      const sourceLabel = source.location.startsWith("ai-outfitter/") ? source.location.slice("ai-outfitter/".length) : source.location;
      if (source.repositoryUrl) { const link = element(this.document, "a"); link.href = source.repositoryUrl; link.textContent = sourceLabel; sourceCell.appendChild(link); }
      else sourceCell.textContent = sourceLabel;

      const refCell = element(this.document, "td");
      refCell.dataset.label = "Ref";
      const ref = element(this.document, "span", "source-ref");
      ref.textContent = source.ref ?? "Unpinned";
      const freshnessIndicator = element(this.document, "span", "source-ref-indicator");
      freshnessIndicator.dataset.sourceRefIndicator = source.id;
      freshnessIndicator.hidden = true;
      refCell.appendChild(ref);
      refCell.appendChild(freshnessIndicator);

      const dependency = element(this.document, "td", "source-dependencies");
      dependency.dataset.label = "Used by";
      if (source.dependencies.length) {
        source.dependencies.forEach((workflow, index) => {
          if (index) dependency.append(", ");
          const link = element(this.document, "a"); link.href = workflowManagerPath(this.login!, workflow); link.textContent = workflow; dependency.appendChild(link);
        });
      } else dependency.textContent = "None";

      const actions = element(this.document, "td", "source-actions");
      actions.dataset.label = "Actions";
      const actionList = element(this.document, "div", "source-action-list");
      const update = element(this.document, "button", "source-action") as HTMLButtonElement;
      update.type = "button"; update.textContent = "Preview update"; update.disabled = true; update.dataset.sourceUpdate = source.id; update.onclick = () => void this.previewSource(source.id, "update");
      const remove = element(this.document, "button", "source-action") as HTMLButtonElement;
      remove.type = "button"; remove.textContent = "Remove"; remove.disabled = source.dependencies.length > 0; remove.onclick = () => void this.previewSource(source.id, "remove");
      actionList.appendChild(update); actionList.appendChild(remove); actions.appendChild(actionList);

      for (const cell of [sourceCell, refCell, dependency, actions]) row.appendChild(cell);
      body.appendChild(row);
    }
    table.appendChild(head);
    table.appendChild(body);
    wrapper.appendChild(table);
    root.replaceChildren(wrapper);
  }

  private async loadFreshness() {
    try {
      const result = await this.request<{ sources: Freshness[] }>(`/api/accounts/${encodeURIComponent(this.login!)}/configuration/freshness`);
      if (!this.active()) return;
      for (const freshness of result.sources) {
        this.freshness.set(freshness.id, freshness);
        const update = [...this.document.querySelectorAll<HTMLButtonElement>("[data-source-update]")].find((element) => element.dataset.sourceUpdate === freshness.id);
        if (update) update.disabled = !freshness.latestRef || freshness.status === "current" || freshness.status === "unavailable" || freshness.status === "invalid" || freshness.status === "local-only";
        const indicator = [...this.document.querySelectorAll<HTMLElement>("[data-source-ref-indicator]")].find((element) => element.dataset.sourceRefIndicator === freshness.id);
        if (indicator) {
          indicator.hidden = freshness.status !== "outdated";
          indicator.textContent = freshness.status === "outdated" ? "↑" : "";
          indicator.setAttribute("role", "img");
          indicator.setAttribute("aria-label", "Update available");
          indicator.title = freshness.latestRef ? `Update available: ${freshness.latestRef}` : "Update available";
        }
      }
    } catch (error) {
      if (this.active() && (error as { name?: string }).name !== "AbortError") this.status(error instanceof Error ? `Source checks failed: ${error.message}` : "Source checks failed.");
    }
  }

  private renderWorkflows() {
    const workflows = this.configuration!.workflows;
    const implementationProfileOrder = new Map([["founder", 0], ["engineer", 1], ["software-factory", 2]]);
    const order = { "needs-attention": 0, customized: 1, enabled: 2, available: 3 };
    const installed = workflows.filter((workflow) => workflow.state !== "available").sort((left, right) => order[left.state] - order[right.state] || (left.title ?? left.id).localeCompare(right.title ?? right.id));
    const available = workflows.filter((workflow) => workflow.state === "available");
    const implementation = available
      .filter((workflow) => implementationProfileOrder.has(workflow.id))
      .sort((left, right) => implementationProfileOrder.get(left.id)! - implementationProfileOrder.get(right.id)!);
    const community = available.filter((workflow) => !implementationProfileOrder.has(workflow.id)).sort((left, right) => (left.title ?? left.id).localeCompare(right.title ?? right.id));
    this.renderWorkflowGroup("installed-workflows", installed, "No workflows are enabled.");
    this.renderWorkflowGroup("implementation-workflows", implementation, "Every implementation profile is enabled.", "h4");
    this.renderWorkflowGroup("community-workflows", community, "Every supporting workflow is enabled.", "h4");
  }

  private renderWorkflowGroup(id: string, workflows: Workflow[], emptyText: string, headingTag: "h3" | "h4" = "h3") {
    const root = required(this.document, id);
    if (!workflows.length) { const empty = element(this.document, "p", "muted"); empty.textContent = emptyText; root.replaceChildren(empty); return; }
    root.replaceChildren(...workflows.map((workflow) => {
      const card = element(this.document, "a", "workflow-card") as HTMLAnchorElement;
      card.href = workflowManagerPath(this.login!, workflow.id);
      const state = badge(this.document, workflow.state);
      if (workflow.state !== "available") card.appendChild(state);
      const title = element(this.document, headingTag); title.textContent = workflow.title ?? workflow.id;
      const summary = element(this.document, "p"); summary.textContent = workflow.reason ?? workflow.description ?? "";
      card.appendChild(title); card.appendChild(summary);
      if (workflow.state === "available") card.appendChild(state);
      return card;
    }));
  }

  private renderManager(workflowId: string) {
    const workflow = this.configuration!.workflows.find((candidate) => candidate.id === workflowId);
    if (!workflow) { this.status("This workflow is not in the current community catalog."); this.renderOverview(); return; }
    required(this.document, "dashboard-overview").hidden = true;
    required(this.document, "onboarding").hidden = true;
    required(this.document, "workflow-manager").hidden = false;
    required<HTMLAnchorElement>(this.document, "manager-back").href = dashboardPath(this.login!);
    required(this.document, "manager-title").textContent = workflow.title ?? workflow.id;
    const state = required(this.document, "manager-state"); state.className = `badge ${workflow.state}`; state.textContent = workflow.state;
    required(this.document, "manager-description").textContent = workflow.reason ?? workflow.description ?? "";
    required(this.document, "manager-source").textContent = workflow.sourceRepository;
    this.renderManagerGraph(workflowId);
    this.renderManagerConfiguration(workflow);
    required(this.document, "repository-options").hidden = Boolean(this.configuration!.repository);
    const actions = required(this.document, "workflow-actions");
    const definitions: Array<{ action: "enable" | "remove"; label: string; primary?: boolean }> = workflow.state === "available"
      ? [{ action: "enable", label: "Preview enablement", primary: true }]
      : [{ action: "remove", label: "Remove enablement" }];
    actions.replaceChildren(...definitions.map(({ action, label, primary }) => {
      const button = element(this.document, "button", `button${primary ? " primary" : ""}`) as HTMLButtonElement;
      button.type = "button"; button.textContent = label; button.dataset.workflowAction = action; button.onclick = () => void this.previewWorkflow(workflow, action); return button;
    }));
  }

  private workflowGraph(workflowId: string) {
    const catalog = required<HTMLScriptElement>(this.document, "dashboard-workflow-graphs");
    return (JSON.parse(catalog.textContent ?? "{}") as Record<string, WorkflowGraph>)[workflowId];
  }

  private renderManagerConfiguration(workflow: Workflow) {
    const rows = required(this.document, "manager-configuration-rows");
    const configuration = workflow.components ?? [];
    rows.replaceChildren(...configuration.map(({ type, component, origin }) => {
      const row = element(this.document, "tr");
      for (const value of [type, component, origin]) { const cell = element(this.document, "td"); cell.textContent = value; row.appendChild(cell); }
      return row;
    }));
    required(this.document, "manager-configuration").hidden = configuration.length === 0;
    required(this.document, "manager-configuration-note").textContent = "Effective components use normal Outfitter precedence; organization resources override catalog resources with the same ID.";
  }

  private renderManagerGraph(workflowId: string) {
    const graph = this.workflowGraph(workflowId);
    const section = required(this.document, "manager-graph");
    section.hidden = !graph;
    if (!graph) return;
    const diagram = required(this.document, "manager-workflow-graph");
    diagram.dataset.workflowTitle = graph.title;
    const canvas = diagram.querySelector<HTMLElement>(".workflow-diagram__canvas");
    const status = diagram.querySelector<HTMLElement>(".workflow-diagram__status");
    const source = diagram.querySelector<HTMLElement>("[data-workflow-source]");
    const nodes = diagram.querySelector<HTMLElement>("[data-workflow-nodes]");
    if (!canvas || !status || !source || !nodes) return;
    canvas.replaceChildren();
    canvas.setAttribute("aria-label", `${graph.title} workflow diagram`);
    status.textContent = "Rendering workflow…";
    source.textContent = graph.source;
    nodes.textContent = JSON.stringify(graph.nodes.map((node) => {
      const referencedWorkflow = node.href?.match(/^\/workflows\/([^/]+)\/?$/)?.[1];
      return referencedWorkflow ? { ...node, href: workflowManagerPath(this.login!, decodeURIComponent(referencedWorkflow)) } : node;
    }));
    void renderWorkflowDiagram(diagram, `dashboard-${workflowId}`, this.abort.signal);
  }

  private async previewWorkflow(workflow: Workflow, action: "enable" | "remove") {
    await this.preview("workflow", {
      target: "workflow", workflow: workflow.id, action,
      private: required<HTMLSelectElement>(this.document, "visibility").value === "private",
    });
  }

  private async previewSource(source: string, action: "update" | "remove") {
    await this.preview("source", { target: "source", source, action });
  }

  private async preview(scope: "workflow" | "source", request: Record<string, unknown>) {
    try {
      this.status(scope === "source" ? "Preparing source update preview…" : "Preparing workflow preview…");
      const result = await this.request<{ token: string; plan: { baseSha: string | null; changes: PlanChange[] } }>(`/api/accounts/${encodeURIComponent(this.login!)}/plans`, { method: "POST", body: JSON.stringify(request) });
      if (!this.active()) return;
      this.planToken = result.token; this.planScope = scope;
      const root = required(this.document, `${scope}-preview`);
      const summary = element(this.document, "p"); summary.textContent = `Previewing ${result.plan.changes.length} file change${result.plan.changes.length === 1 ? "" : "s"}.`;
      const details = result.plan.changes.map((change) => {
        const item = element(this.document, "details"); const heading = element(this.document, "summary"); const content = element(this.document, "pre");
        heading.textContent = `${change.action.toUpperCase()} ${change.path}`; content.textContent = change.after ?? "(deleted)"; item.appendChild(heading); item.appendChild(content); return item;
      });
      root.replaceChildren(summary, ...details);
      if (scope === "source") {
        const panel = required(this.document, "source-plan");
        panel.hidden = false;
        panel.focus({ preventScroll: true });
        if (typeof panel.scrollIntoView === "function") panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      const apply = required(this.document, `${scope}-apply-actions`); apply.hidden = false;
      const pr = apply.querySelector<HTMLButtonElement>('[data-apply="pull-request"]');
      const direct = apply.querySelector<HTMLButtonElement>('[data-apply="direct"]');
      if (pr) pr.hidden = result.plan.baseSha === null;
      if (direct) direct.textContent = result.plan.baseSha === null ? "Create repository" : "Commit to default branch";
      this.status("Review the change below, then choose how to apply it.");
    } catch (error) {
      if (!this.active() || (error as { name?: string }).name === "AbortError") return;
      this.planToken = null; this.planScope = null; this.showError(error);
    }
  }

  private async apply(mode: "pull-request" | "direct") {
    if (!this.planToken || !this.planScope) return this.status("Preview the repository change first.");
    if (!confirm(mode === "direct" ? "Commit these changes to the default branch?" : "Open a pull request with these changes?")) return;
    const actions = required(this.document, `${this.planScope}-apply-actions`);
    const buttons = [...actions.querySelectorAll<HTMLButtonElement>("button[data-apply]")];
    const labels = buttons.map((button) => button.textContent ?? "");
    const selected = buttons.find((button) => button.dataset.apply === mode);
    actions.setAttribute("aria-busy", "true");
    buttons.forEach((button) => { button.disabled = true; });
    if (selected) { selected.classList.add("loading"); selected.textContent = mode === "pull-request" ? "Opening pull request…" : "Committing…"; }
    this.status(mode === "pull-request" ? "Creating the GitHub pull request…" : "Committing the change to GitHub…");
    const restore = () => {
      actions.removeAttribute("aria-busy");
      buttons.forEach((button, index) => { button.disabled = false; button.classList.remove("loading"); button.textContent = labels[index]; });
    };
    try {
      const result = await this.request<{ pullRequestUrl?: string; commitUrl?: string }>(`/api/accounts/${encodeURIComponent(this.login!)}/plans/apply`, { method: "POST", body: JSON.stringify({ token: this.planToken, mode }) });
      if (!this.active()) return;
      const target = result.pullRequestUrl ?? result.commitUrl;
      if (!target) { restore(); return this.status("GitHub completed the request without returning a destination."); }
      this.status(mode === "pull-request" ? "Pull request created. Opening GitHub…" : "Commit created. Opening GitHub…");
      this.location.assign(target);
    } catch (error) {
      if (this.active()) restore();
      if (this.active() && (error as { name?: string }).name !== "AbortError") this.showError(error);
    }
  }

  private async renderOnboarding() {
    const data = this.configuration!;
    required(this.document, "dashboard-overview").hidden = true;
    required(this.document, "workflow-manager").hidden = true;
    required(this.document, "onboarding").hidden = false;
    required<HTMLAnchorElement>(this.document, "onboarding-overview-link").href = dashboardPath(this.login!);
    required(this.document, "onboarding-title").textContent = `Set up ${data.login}'s first workflow`;
    if (data.repository && !data.settings.workflows.includes(this.onboarding.workflow)) {
      const enabled = ONBOARDING_CHOICES.find((choice) => data.settings.workflows.includes(choice.id));
      if (enabled) this.onboarding.workflow = enabled.id;
    }
    this.renderOnboardingChoices();
    this.renderOnboardingRepository();
    this.renderOnboardingCommands();
    if (!this.onboarding.playground) await this.loadPlayground();
    this.renderOnboardingPlayground();
  }

  private renderOnboardingChoices() {
    const data = this.configuration!;
    const root = required(this.document, "onboarding-workflow-choices");
    const locked = Boolean(data.repository);
    root.replaceChildren(...ONBOARDING_CHOICES.flatMap((choice) => {
      const workflow = data.workflows.find((candidate) => candidate.id === choice.id);
      if (!workflow) return [];
      const button = element(this.document, "button", "workflow-choice") as HTMLButtonElement;
      button.type = "button"; button.setAttribute("role", "radio"); button.dataset.workflow = choice.id;
      button.setAttribute("aria-checked", String(this.onboarding.workflow === choice.id));
      button.disabled = locked && this.onboarding.workflow !== choice.id;
      const label = badge(this.document, choice.recommended ? "recommended" : workflow.state === "available" ? "available" : workflow.state);
      const title = element(this.document, "h4"); title.textContent = workflow.title ?? workflow.id;
      const summary = element(this.document, "p"); summary.textContent = choice.note;
      button.appendChild(label); button.appendChild(title); button.appendChild(summary);
      button.onclick = () => { if (locked) return; this.onboarding.workflow = choice.id; this.onboarding.planToken = null; this.renderOnboardingChoices(); this.renderOnboardingRepository(); this.renderOnboardingCommands(); };
      return [button];
    }));
    const state = required(this.document, "onboarding-workflow-state");
    state.className = "badge selected"; state.textContent = this.onboarding.workflow;
  }

  private setStep(id: string, state: "done" | "pending" | "ready", label: string) {
    const target = required(this.document, id); target.className = `badge ${state}`; target.textContent = label;
  }

  private renderOnboardingRepository() {
    const data = this.configuration!;
    const exists = Boolean(data.repository);
    required(this.document, "onboarding-repository-title").textContent = `Create ${data.login}/.agents`;
    const summary = required(this.document, "onboarding-repository-summary");
    summary.replaceChildren();
    if (exists) {
      const link = element(this.document, "a"); link.href = data.repositoryUrl; link.textContent = data.repository!.fullName;
      summary.appendChild(link); summary.append(` exists${data.settings.workflows.includes(this.onboarding.workflow) ? ` with ${this.onboarding.workflow} enabled` : ""}. `);
      if (!data.settings.workflows.includes(this.onboarding.workflow)) summary.append("Preview the change to enable the selected workflow.");
    } else summary.textContent = this.onboarding.workflow === "engineer"
      ? "Creates settings.yml pinned to the community catalog with the engineer workflow enabled, plus a local-engineer lead, an implementer, and a reviewer agent so the loop runs from a workstation."
      : `Creates settings.yml pinned to the community catalog with the ${this.onboarding.workflow} workflow enabled.`;
    required(this.document, "onboarding-repository-options").hidden = exists;
    required(this.document, "onboarding-preview").hidden = exists && data.settings.workflows.includes(this.onboarding.workflow);
    required<HTMLButtonElement>(this.document, "onboarding-preview").textContent = exists ? "Preview change" : "Preview repository";
    required<HTMLButtonElement>(this.document, "onboarding-apply").textContent = exists ? "Commit to default branch" : "Create repository";
    if (!this.onboarding.planToken) { required(this.document, "onboarding-preview-output").replaceChildren(); required(this.document, "onboarding-apply-actions").hidden = true; }
    const done = exists && data.settings.workflows.includes(this.onboarding.workflow);
    this.setStep("onboarding-repository-state", done ? "done" : "pending", done ? "done" : exists ? "update needed" : "not created");
  }

  private async onboardingPreview() {
    try {
      this.status("Preparing the repository preview…");
      const request = { target: "onboarding", workflow: this.onboarding.workflow, private: required<HTMLSelectElement>(this.document, "onboarding-visibility").value === "private" };
      const result = await this.request<{ token: string; plan: { baseSha: string | null; changes: PlanChange[] } }>(`/api/accounts/${encodeURIComponent(this.login!)}/plans`, { method: "POST", body: JSON.stringify(request) });
      if (!this.active()) return;
      this.onboarding.planToken = result.token;
      const root = required(this.document, "onboarding-preview-output");
      const summary = element(this.document, "p"); summary.textContent = `Previewing ${result.plan.changes.length} file change${result.plan.changes.length === 1 ? "" : "s"}.`;
      root.replaceChildren(summary, ...result.plan.changes.map((change) => {
        const item = element(this.document, "details"); const heading = element(this.document, "summary"); const content = element(this.document, "pre");
        heading.textContent = `${change.action.toUpperCase()} ${change.path}`; content.textContent = change.after ?? "(deleted)"; item.appendChild(heading); item.appendChild(content); return item;
      }));
      required(this.document, "onboarding-apply-actions").hidden = false;
      this.status("Review the files, then create the repository.");
    } catch (error) {
      if (!this.active() || (error as { name?: string }).name === "AbortError") return;
      this.onboarding.planToken = null; this.showError(error);
    }
  }

  private async onboardingApply() {
    if (!this.onboarding.planToken) return this.status("Preview the repository first.");
    const button = required<HTMLButtonElement>(this.document, "onboarding-apply");
    const label = button.textContent ?? "";
    button.disabled = true; button.classList.add("loading"); button.textContent = "Committing…";
    this.status("Committing to GitHub…");
    try {
      const result = await this.request<{ commitUrl?: string; commitSha?: string }>(`/api/accounts/${encodeURIComponent(this.login!)}/plans/apply`, { method: "POST", body: JSON.stringify({ token: this.onboarding.planToken, mode: "direct" }) });
      if (!this.active()) return;
      this.onboarding.planToken = null;
      this.onboarding.headSha = result.commitSha ?? null;
      const loaded = await this.request<Configuration>(`/api/accounts/${encodeURIComponent(this.login!)}/configuration`);
      if (!this.active()) return;
      this.configuration = loaded;
      if (this.index?.activeAccount && loaded.repository) { this.index.activeAccount.repository = loaded.repository; publishAuthState(this.document, updateCachedAccountIndex(this.index)); }
      await this.renderOnboarding();
      this.status("Repository ready. Continue with the playground.");
    } catch (error) {
      if (this.active() && (error as { name?: string }).name !== "AbortError") this.showError(error);
    } finally {
      if (this.active()) { button.disabled = false; button.classList.remove("loading"); button.textContent = label; }
    }
  }

  private async loadPlayground() {
    try {
      this.onboarding.playground = await this.request<Playground>(`/api/accounts/${encodeURIComponent(this.login!)}/playground`);
    } catch (error) {
      if ((error as { status?: number }).status !== 404 && this.active() && (error as { name?: string }).name !== "AbortError") this.status(error instanceof Error ? `Playground lookup failed: ${error.message}` : "Playground lookup failed.");
    }
  }

  private renderOnboardingPlayground() {
    const playground = this.onboarding.playground;
    const summary = required(this.document, "onboarding-playground-summary");
    const button = required<HTMLButtonElement>(this.document, "onboarding-playground");
    summary.replaceChildren();
    if (!playground) { this.setStep("onboarding-playground-state", "pending", "not created"); button.hidden = false; button.textContent = "Create playground"; this.renderOnboardingCommands(); return; }
    const repository = element(this.document, "a"); repository.href = playground.repository.url; repository.textContent = playground.repository.fullName;
    summary.appendChild(repository);
    if (playground.issue.number) { const issue = element(this.document, "a"); issue.href = playground.issue.url; issue.textContent = `Issue #${playground.issue.number}: ${playground.issue.title}`; summary.appendChild(issue); }
    const complete = playground.issue.number > 0;
    this.setStep("onboarding-playground-state", complete ? "done" : "pending", complete ? "done" : "issue missing");
    button.hidden = complete; button.textContent = "File the issue";
    this.renderOnboardingCommands();
  }

  private async onboardingPlayground() {
    const button = required<HTMLButtonElement>(this.document, "onboarding-playground");
    const label = button.textContent ?? "";
    button.disabled = true; button.classList.add("loading"); button.textContent = "Forking…";
    this.status("Forking the playground and filing its issue…");
    try {
      this.onboarding.playground = await this.request<Playground>(`/api/accounts/${encodeURIComponent(this.login!)}/playground`, { method: "POST", body: "{}" });
      if (!this.active()) return;
      this.renderOnboardingPlayground();
      this.status("Playground ready. Run the commands below from your workstation.");
    } catch (error) {
      if (this.active() && (error as { name?: string }).name !== "AbortError") this.showError(error);
    } finally {
      if (this.active()) { button.disabled = false; button.classList.remove("loading"); button.textContent = label; }
    }
  }

  private onboardingCommands() {
    const data = this.configuration!;
    const login = data.login;
    const ref = this.onboarding.headSha ?? data.repository?.headSha ?? "main";
    const playground = this.onboarding.playground;
    const repo = playground?.repository.fullName ?? `${login}/${PLAYGROUND_REPOSITORY}`;
    const issue = playground?.issue.number ? `${repo}#${playground.issue.number}` : `${repo}#<issue>`;
    const agent = this.onboarding.workflow === "engineer" ? "local-engineer" : this.onboarding.workflow;
    return [
      "npm install -g @ai-outfitter/outfitter",
      "mkdir -p ~/.agents",
      "test -e ~/.agents/settings.yml && echo 'merge the entries below into ~/.agents/settings.yml' || cat > ~/.agents/settings.yml <<'EOF'",
      "default_harness: pi",
      "remote_settings:",
      `  - github: ${login}/.agents`,
      "    path: settings.yml",
      `    ref: ${ref}`,
      "sources:",
      `  - github: ${login}/.agents`,
      `    ref: ${ref}`,
      "EOF",
      "outfitter sync",
      `gh repo clone ${repo} ~/${PLAYGROUND_REPOSITORY}`,
      `cd ~/${PLAYGROUND_REPOSITORY}`,
      `outfitter run ${agent} -- "Take ${issue} to a merged pull request."`,
    ].join("\n");
  }

  private renderOnboardingCommands() {
    const data = this.configuration!;
    required(this.document, "onboarding-commands").textContent = this.onboardingCommands();
    const ready = Boolean(data.repository) && Boolean(this.onboarding.playground?.issue.number);
    this.setStep("onboarding-local-state", ready ? "ready" : "pending", ready ? "ready to run" : "waiting on steps above");
    required(this.document, "onboarding-local-note").textContent = ready
      ? "The pin is the .agents commit this page created; move it deliberately when the catalog changes. The reviewer submits a formal pull request review; GitHub only lets a second identity approve, so a single-identity run delivers the verdict as a comment review that opens with APPROVE."
      : "The commands fill in the catalog pin and the issue number once the repository and playground exist.";
  }

  private async copyCommands() {
    try {
      await navigator.clipboard.writeText(this.onboardingCommands());
      this.status("Commands copied.");
    } catch { this.status("Copy failed; select the commands and copy them manually."); }
  }

  private status(message: string) { if (this.active()) required(this.document, "dashboard-status").textContent = message; }
  private showError(error: unknown) { this.status(error instanceof Error ? error.message : "Unexpected dashboard error"); }
}

export function startDashboard(documentRef: Document = document, fetcher: Fetcher = fetch, locationRef: Location = location, historyRef: History = history) {
  return new DashboardController(documentRef, fetcher, locationRef, historyRef).start();
}

let activeController: DashboardController | null = null;

export function installDashboardLifecycle(documentRef: Document = document) {
  const start = () => {
    activeController?.dispose();
    activeController = null;
    if (!documentRef.querySelector("[data-dashboard]")) return;
    activeController = new DashboardController(documentRef, fetch, location, history);
    void activeController.start();
  };
  documentRef.addEventListener("astro:before-swap", () => {
    activeController?.dispose();
    activeController = null;
  });
  documentRef.addEventListener("astro:page-load", start);
  return start;
}
