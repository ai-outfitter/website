import { assessLocalExecution, type InstalledWorkflowState } from "../dashboard/capabilities";

type Repository = {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  canPush: boolean;
};

type Counts = { installed: number; outdated: number; overridden: number };

type Account = {
  login: string;
  type: "User" | "Organization";
  installationId: number;
  repository: Repository | null;
  active?: boolean;
  counts?: Counts;
};

type Workflow = {
  id: string;
  title?: string;
  description?: string;
  sourceSha: string;
  state: "add" | "installed" | "outdated" | "overridden";
  action: "add" | "update" | "none";
  reason?: string;
};

type AccountIndex = {
  user: { name?: string; email?: string };
  activeAccount: Account | null;
  accounts: Account[];
  githubAppSlug: string;
};

type WorkflowResponse = {
  login: string;
  repository: Repository | null;
  repositoryUrl: string;
  workflows: Workflow[];
};

type Resource = { path: string; files: number };
type PlanChange = { path: string; action: string; after: string | null };

type Fetcher = typeof fetch;

function required<T = HTMLElement>(document: Document, id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Dashboard element #${id} is missing`);
  return element as T;
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
  const response = await fetcher(path, {
    ...options,
    headers: { "content-type": "application/json", ...options?.headers },
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : `Request failed with status ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return response.json() as Promise<T>;
}

export class DashboardController {
  private index: AccountIndex | null = null;
  private workflowData: WorkflowResponse | null = null;
  private planToken: string | null = null;

  constructor(
    private readonly document: Document,
    private readonly fetcher: Fetcher,
    private readonly location: Location,
  ) {}

  async start() {
    this.bindAuth();
    try {
      this.index = await api<AccountIndex>(this.fetcher, "/api/accounts");
    } catch (error) {
      if ((error as { status?: number }).status === 401) return;
      this.showError(error);
      return;
    }

    required(this.document, "signed-out").hidden = true;
    required(this.document, "signed-in").hidden = false;
    const install = required<HTMLAnchorElement>(this.document, "install-app");
    install.href = `https://github.com/apps/${encodeURIComponent(this.index.githubAppSlug)}/installations/new`;

    await this.acceptInstallationReturn();
    this.renderAccounts();
    const selected = this.requestedAccount() ?? this.index.activeAccount?.login ?? this.index.accounts[0]?.login;
    if (!selected) {
      this.status("Install the GitHub App for a personal or organization account to continue.");
      return;
    }
    const select = required<HTMLSelectElement>(this.document, "account");
    select.replaceChildren(...this.index.accounts.map((account) => new Option(`${account.login} · ${account.type}`, account.login)));
    select.value = selected;
    select.onchange = () => void this.selectAccount(select.value);
    await this.loadAccount(selected);
  }

  private bindAuth() {
    required<HTMLButtonElement>(this.document, "sign-in").onclick = () => void this.signIn();
    required<HTMLButtonElement>(this.document, "sign-out").onclick = () => void this.signOut();
    required<HTMLButtonElement>(this.document, "create").onclick = () => void this.createRepository();
    required<HTMLButtonElement>(this.document, "preview").onclick = () => void this.preview();
    required<HTMLButtonElement>(this.document, "open-pr").onclick = () => void this.apply("pull-request");
    required<HTMLButtonElement>(this.document, "direct-commit").onclick = () => void this.apply("direct");
  }

  private async signIn() {
    try {
      const callback = new URL(this.location.href);
      const data = await api<{ url: string }>(this.fetcher, "/api/auth/sign-in/social", {
        method: "POST",
        body: JSON.stringify({ provider: "github", callbackURL: `${callback.pathname}${callback.search}` }),
      });
      this.location.assign(data.url);
    } catch (error) {
      this.showError(error);
    }
  }

  private async signOut() {
    await this.fetcher("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" } });
    this.location.reload();
  }

  private requestedAccount() {
    const requested = new URL(this.location.href).searchParams.get("account");
    return requested && this.index?.accounts.some((account) => account.login === requested) ? requested : null;
  }

  private requestedWorkflow() {
    return new URL(this.location.href).searchParams.get("workflow");
  }

  private async acceptInstallationReturn() {
    if (!this.index) return;
    const url = new URL(this.location.href);
    const installationId = url.searchParams.get("installation_id");
    if (!installationId) return;
    const account = this.index.accounts.find((candidate) => String(candidate.installationId) === installationId);
    if (!account) {
      this.status("The returned GitHub App installation is not accessible to this session.");
      return;
    }
    await this.setActiveAccount(account.login);
    url.searchParams.delete("installation_id");
    url.searchParams.delete("setup_action");
    url.searchParams.set("account", account.login);
    history.replaceState(null, "", url);
  }

  private renderAccounts() {
    if (!this.index) return;
    const root = required(this.document, "account-cards");
    root.replaceChildren(...this.index.accounts.map((account) => {
      const card = element(this.document, "article", "account-card");
      card.dataset.active = String(account.login === this.index?.activeAccount?.login);
      card.appendChild(badge(this.document, account.login === this.index?.activeAccount?.login ? "available" : account.type.toLowerCase()));
      const title = element(this.document, "h3");
      title.textContent = account.login;
      const repository = element(this.document, "p", "muted");
      repository.textContent = account.repository
        ? `${account.repository.private ? "Private" : "Public"} .agents repository`
        : "No accessible .agents repository";
      const counts = element(this.document, "div", "counts");
      const values = account.counts ?? { installed: 0, outdated: 0, overridden: 0 };
      for (const [label, value] of Object.entries(values)) {
        const item = element(this.document, "span");
        item.textContent = `${value} ${label}`;
        counts.appendChild(item);
      }
      card.appendChild(title);
      card.appendChild(repository);
      card.appendChild(counts);
      return card;
    }));
  }

  private async setActiveAccount(login: string) {
    const response = await api<{ activeAccount: Account }>(this.fetcher, "/api/accounts/active", {
      method: "PUT",
      body: JSON.stringify({ login }),
    });
    if (this.index) this.index.activeAccount = response.activeAccount;
  }

  private async selectAccount(login: string) {
    try {
      await this.setActiveAccount(login);
      const url = new URL(this.location.href);
      url.searchParams.set("account", login);
      url.searchParams.delete("workflow");
      history.replaceState(null, "", url);
      this.renderAccounts();
      await this.loadAccount(login);
    } catch (error) {
      this.showError(error);
    }
  }

  private async loadAccount(login: string) {
    try {
      this.planToken = null;
      required(this.document, "apply-actions").hidden = true;
      required(this.document, "preview-output").replaceChildren();
      this.workflowData = await api<WorkflowResponse>(this.fetcher, `/api/accounts/${encodeURIComponent(login)}/workflows`);
      required(this.document, "manager-title").textContent = `${login}/.agents`;
      const repositoryLink = required<HTMLAnchorElement>(this.document, "repository-link");
      repositoryLink.href = this.workflowData.repositoryUrl;
      repositoryLink.hidden = !this.workflowData.repository;
      this.populateWorkflows();
      this.renderWorkflowCards();

      const create = required(this.document, "create-repository");
      const manage = required(this.document, "manage-repository");
      create.hidden = Boolean(this.workflowData.repository);
      manage.hidden = !this.workflowData.repository;
      if (this.workflowData.repository) {
        required<HTMLButtonElement>(this.document, "direct-commit").disabled = !this.workflowData.repository.canPush;
        await this.renderResources(login);
      } else {
        required(this.document, "resources").replaceChildren();
      }
    } catch (error) {
      this.showError(error);
    }
  }

  private populateWorkflows() {
    if (!this.workflowData) return;
    const select = required<HTMLSelectElement>(this.document, "workflow");
    const options = this.workflowData.workflows.map((workflow) => new Option(workflow.title ?? workflow.id, workflow.id));
    options.push(new Option("Remove selected managed resources", ""));
    select.replaceChildren(...options);
    const requested = this.requestedWorkflow();
    if (requested && this.workflowData.workflows.some((workflow) => workflow.id === requested)) select.value = requested;
    select.onchange = () => this.renderWorkflowSelection();
    this.renderWorkflowSelection();
  }

  private renderWorkflowSelection() {
    const select = required<HTMLSelectElement>(this.document, "workflow");
    const workflow = this.workflowData?.workflows.find((candidate) => candidate.id === select.value);
    required(this.document, "workflow-description").textContent = workflow
      ? `${workflow.description ?? ""} Source ${workflow.sourceSha.slice(0, 12)}.`
      : "No workflow will be added; only selected managed resources will be removed.";
    const assessment = assessLocalExecution(workflow?.state as InstalledWorkflowState);
    const readiness = required(this.document, "local-readiness");
    readiness.replaceChildren(badge(this.document, assessment.state));
    const title = element(this.document, "h3");
    title.textContent = assessment.title;
    const summary = element(this.document, "p", "muted");
    summary.textContent = assessment.summary;
    readiness.appendChild(title);
    readiness.appendChild(summary);
  }

  private renderWorkflowCards() {
    const root = required(this.document, "workflow-cards");
    root.replaceChildren(...(this.workflowData?.workflows ?? []).map((workflow) => {
      const card = element(this.document, "article", "workflow-card");
      card.appendChild(badge(this.document, workflow.state));
      const title = element(this.document, "h3");
      title.textContent = workflow.title ?? workflow.id;
      const summary = element(this.document, "p");
      summary.textContent = workflow.reason ?? workflow.description ?? "";
      card.appendChild(title);
      card.appendChild(summary);
      return card;
    }));
  }

  private async renderResources(login: string) {
    const data = await api<{ resources: Resource[] }>(this.fetcher, `/api/accounts/${encodeURIComponent(login)}/repository/resources`);
    const root = required(this.document, "resources");
    if (!data.resources.length) {
      const empty = element(this.document, "p", "muted");
      empty.textContent = "No managed workflow resources are installed yet.";
      root.replaceChildren(empty);
      return;
    }
    root.replaceChildren(...data.resources.map((resource) => {
      const card = element(this.document, "div", "resource-card");
      const label = element(this.document, "label");
      const checkbox = element(this.document, "input") as HTMLInputElement;
      checkbox.type = "checkbox";
      checkbox.dataset.delete = resource.path;
      const text = element(this.document, "span");
      text.textContent = `${resource.path} · ${resource.files} file${resource.files === 1 ? "" : "s"}`;
      label.appendChild(checkbox);
      label.appendChild(text);
      card.appendChild(label);
      return card;
    }));
  }

  private async createRepository() {
    const login = required<HTMLSelectElement>(this.document, "account").value;
    const workflow = required<HTMLSelectElement>(this.document, "workflow").value;
    if (!workflow) return this.status("Choose a workflow before creating the repository.");
    if (!confirm(`Create ${login}/.agents and its initial commit?`)) return;
    try {
      const result = await api<{ commitUrl: string }>(this.fetcher, `/api/accounts/${encodeURIComponent(login)}/repository`, {
        method: "POST",
        body: JSON.stringify({
          workflow,
          private: required<HTMLSelectElement>(this.document, "visibility").value === "private",
        }),
      });
      this.location.assign(result.commitUrl);
    } catch (error) {
      this.showError(error);
    }
  }

  private selectedDeletes() {
    return [...this.document.querySelectorAll<HTMLInputElement>("[data-delete]:checked")]
      .map((input) => input.dataset.delete)
      .filter((value): value is string => Boolean(value));
  }

  private async preview() {
    const login = required<HTMLSelectElement>(this.document, "account").value;
    const workflow = required<HTMLSelectElement>(this.document, "workflow").value;
    try {
      const result = await api<{ token: string; plan: { changes: PlanChange[] } }>(this.fetcher, `/api/accounts/${encodeURIComponent(login)}/plans`, {
        method: "POST",
        body: JSON.stringify({ workflow: workflow || undefined, deletes: this.selectedDeletes() }),
      });
      this.planToken = result.token;
      const root = required(this.document, "preview-output");
      const summary = element(this.document, "p");
      summary.textContent = `${result.plan.changes.length} exact file change${result.plan.changes.length === 1 ? "" : "s"}.`;
      const details = result.plan.changes.map((change) => {
        const item = element(this.document, "details");
        const heading = element(this.document, "summary");
        heading.textContent = `${change.action.toUpperCase()} ${change.path}`;
        const content = element(this.document, "pre");
        content.textContent = change.after ?? "(deleted)";
        item.appendChild(heading);
        item.appendChild(content);
        return item;
      });
      root.replaceChildren(summary, ...details);
      required(this.document, "apply-actions").hidden = false;
    } catch (error) {
      this.planToken = null;
      required(this.document, "apply-actions").hidden = true;
      this.showError(error);
    }
  }

  private async apply(mode: "pull-request" | "direct") {
    if (!this.planToken) return this.status("Preview the repository change first.");
    if (!confirm(mode === "direct" ? "Commit this exact preview to the default branch?" : "Open a pull request with this exact preview?")) return;
    const login = required<HTMLSelectElement>(this.document, "account").value;
    try {
      const result = await api<{ pullRequestUrl?: string; commitUrl?: string }>(this.fetcher, `/api/accounts/${encodeURIComponent(login)}/plans/apply`, {
        method: "POST",
        body: JSON.stringify({ token: this.planToken, mode }),
      });
      const target = result.pullRequestUrl ?? result.commitUrl;
      if (target) this.location.assign(target);
    } catch (error) {
      this.showError(error);
    }
  }

  private status(message: string) {
    required(this.document, "dashboard-status").textContent = message;
  }

  private showError(error: unknown) {
    this.status(error instanceof Error ? error.message : "Unexpected dashboard error");
  }
}

export function startDashboard(
  documentRef: Document = document,
  fetcher: Fetcher = fetch,
  locationRef: Location = location,
) {
  const controller = new DashboardController(documentRef, fetcher, locationRef);
  return controller.start();
}
