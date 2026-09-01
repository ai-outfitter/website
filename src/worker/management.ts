import type { Octokit } from "@octokit/core";
import { base64url, secureEqual } from "./crypto";
import { sourceFreshness, textBlob, tree } from "./github";
import { pinGitHubSource, removeSource, setSourceRef, summarizeSettings, unpinGitHubSource } from "./settings";
import { classifyWorkflow, readManifest } from "./status";

export type WorkflowState = "add" | "installed" | "outdated" | "overridden";
export type InstallStrategy = "catalog-reference" | "vendored";
export type WorkflowAction = "install" | "update" | "repair" | "remove";
export type SourceAction = "update" | "remove";
export type WorkflowStatus = { id: string; state: WorkflowState; sourceSha: string; strategy?: InstallStrategy; reason?: string };
export type Change = { path: string; action: "add" | "update" | "delete"; before: string | null; after: string | null; mode: "100644" | "100755" };
export type Plan = {
  version: 1;
  repository: string;
  baseSha: string | null;
  sourceSha: string;
  intent: { target: "workflow"; id: string; action: WorkflowAction } | { target: "source"; id: string; action: SourceAction };
  create?: { private: boolean; accountType: "User" | "Organization" };
  changes: Change[];
  warnings: string[];
  expiresAt: number;
};
export type BundleFile = { path: string; content: string; mode: "100644" | "100755"; sha256: string; blobSha?: string };
export type WorkflowBundle = { id: string; title?: string; description?: string; sourceRepository: string; sourceSha: string; files: BundleFile[] };
export type Catalog = { sourceRepository: string; sourceSha: string; workflows: WorkflowBundle[] };
export type ManagedManifest = {
  version: 1;
  workflows: Record<string, {
    source: { github: string; ref: string };
    sourceSha: string;
    strategy: InstallStrategy;
    managesSource: boolean;
    files: Record<string, string>;
  }>;
  files: Record<string, { sha256: string; workflows: string[] }>;
};
export type RepositorySnapshot = { sha: string; files: Record<string, { mode: string; blobSha: string; sha256?: string }>; manifest: ManagedManifest | null };
export type PlanRequest =
  | { target: "workflow"; workflow: string; action: WorkflowAction; strategy?: InstallStrategy; private?: boolean; accountType?: "User" | "Organization" }
  | { target: "source"; source: string; action: SourceAction };

const safe = /^(?:settings\.yml|(?:agents|skills|prompts|workflows|\.outfitter)\/[A-Za-z0-9._/-]+)$/;
const manifestPath = ".outfitter/website-managed.json";
const omittedComposition = ".outfitter/workflow-composition.json";

export function isManagedPath(path: string) {
  return path !== manifestPath && safe.test(path) && !path.includes("..");
}

export async function sha256(content: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function catalogFrom(workflows: WorkflowBundle[]): Catalog {
  const sourceSha = workflows[0]?.sourceSha ?? "";
  const sourceRepository = workflows[0]?.sourceRepository ?? "";
  if (workflows.some((workflow) => workflow.sourceSha !== sourceSha || workflow.sourceRepository !== sourceRepository)) throw new Error("Catalog workflows must share one source revision");
  return { sourceRepository, sourceSha, workflows };
}

type SelectedWorkflow = { bundle: WorkflowBundle; strategy: InstallStrategy; managesSource: boolean };

async function desiredWorkflowFiles(selected: SelectedWorkflow[], currentSettings?: string, removeManagedCatalogSource = false): Promise<BundleFile[]> {
  if (!selected.length) return [];
  let settings = currentSettings;
  if (selected.some(({ strategy }) => strategy === "catalog-reference")) settings = pinGitHubSource(settings, selected[0].bundle.sourceRepository, selected[0].bundle.sourceSha);
  else if (settings !== undefined && removeManagedCatalogSource) settings = unpinGitHubSource(settings, selected[0].bundle.sourceRepository);

  const union = new Map<string, BundleFile>();
  const owners = new Map<string, string[]>();
  for (const { bundle, strategy } of selected) {
    const inputs = strategy === "catalog-reference"
      ? [{ path: "settings.yml", content: settings ?? "{}\n", mode: "100644" as const, sha256: "" }]
      : bundle.files.filter((file) => file.path !== omittedComposition);
    for (const input of inputs) {
      if (!safe.test(input.path)) throw new Error(`Catalog contains an unsafe path: ${input.path}`);
      const file = { ...input, sha256: await sha256(input.content) };
      const previous = union.get(file.path);
      if (previous && (previous.content !== file.content || previous.mode !== file.mode)) throw new Error(`Catalog collision at ${file.path}`);
      union.set(file.path, file);
      owners.set(file.path, [...new Set([...(owners.get(file.path) ?? []), bundle.id])].sort());
    }
  }
  const workflows = Object.fromEntries(selected
    .sort((left, right) => left.bundle.id.localeCompare(right.bundle.id))
    .map(({ bundle, strategy, managesSource }) => [bundle.id, {
      source: { github: bundle.sourceRepository, ref: bundle.sourceSha },
      sourceSha: bundle.sourceSha,
      strategy,
      managesSource,
      files: Object.fromEntries([...union]
        .filter(([path]) => owners.get(path)?.includes(bundle.id))
        .map(([path, file]) => [path, file.sha256])
        .sort(([left], [right]) => left.localeCompare(right))),
    }]));
  const files = Object.fromEntries([...union]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, file]) => [path, { sha256: file.sha256, workflows: owners.get(path)! }]));
  const content = `${JSON.stringify({ version: 1, workflows, files } satisfies ManagedManifest, null, 2)}\n`;
  return [...[...union.values()].sort((left, right) => left.path.localeCompare(right.path)), { path: manifestPath, content, mode: "100644", sha256: await sha256(content) }];
}

export async function managedBundleFiles(input: WorkflowBundle | WorkflowBundle[], strategy: InstallStrategy = "vendored", currentSettings?: string) {
  const workflows = Array.isArray(input) ? input : [input];
  if (!workflows.length) throw new Error("At least one workflow is required");
  const alreadyConfigured = summarizeSettings(currentSettings ?? "").sources.some((source) => source.github === workflows[0].sourceRepository);
  return desiredWorkflowFiles(workflows.map((bundle, index) => ({ bundle, strategy, managesSource: strategy === "catalog-reference" && index === 0 && !alreadyConfigured })), currentSettings);
}

export async function repositorySnapshot(client: Octokit, owner: string): Promise<RepositorySnapshot> {
  const listing = await tree(client, owner, "HEAD");
  if (listing.truncated) throw new Error("Repository tree is too large to manage safely");
  const files: RepositorySnapshot["files"] = Object.fromEntries(listing.entries.filter((entry) => entry.type === "blob").map((entry) => [entry.path, { mode: entry.mode, blobSha: entry.sha }]));
  const entry = listing.entries.find((candidate) => candidate.path === manifestPath && candidate.type === "blob");
  let manifest: ManagedManifest | null = null;
  if (entry) try { manifest = readManifest(JSON.parse(await textBlob(client, owner, entry.sha))); } catch { manifest = null; }
  for (const path of Object.keys(manifest?.files ?? {})) if (isManagedPath(path) && files[path]) files[path].sha256 = await sha256(await textBlob(client, owner, files[path].blobSha));
  return { sha: listing.sha, files, manifest };
}

export function workflowStatuses(catalog: Catalog, snapshot: RepositorySnapshot) {
  return catalog.workflows.map((workflow) => classifyWorkflow(workflow, catalog, snapshot));
}

async function currentText(client: Octokit, owner: string, snapshot: RepositorySnapshot, path: string) {
  const entry = snapshot.files[path];
  return entry ? textBlob(client, owner, entry.blobSha) : null;
}

async function diff(client: Octokit, owner: string, current: RepositorySnapshot, desired: BundleFile[]) {
  const desiredPaths = new Set(desired.map((file) => file.path));
  const changes: Change[] = [];
  for (const file of desired) {
    const existing = current.files[file.path];
    const before = await currentText(client, owner, current, file.path);
    if (before !== file.content || existing?.mode !== file.mode) changes.push({ path: file.path, action: existing ? "update" : "add", before, after: file.content, mode: file.mode });
  }
  for (const [path, record] of Object.entries(current.manifest?.files ?? {})) {
    if (!isManagedPath(path) || desiredPaths.has(path)) continue;
    const existing = current.files[path];
    if (existing?.sha256 === record.sha256) changes.push({ path, action: "delete", before: await currentText(client, owner, current, path), after: null, mode: existing.mode === "100755" ? "100755" : "100644" });
  }
  if (!desiredPaths.has(manifestPath) && current.files[manifestPath]) changes.push({ path: manifestPath, action: "delete", before: await currentText(client, owner, current, manifestPath), after: null, mode: "100644" });
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

function validateWorkflowAction(status: WorkflowStatus, action: WorkflowAction) {
  const valid = action === "install" ? status.state === "add"
    : action === "update" ? status.state === "outdated" || status.state === "installed"
      : action === "repair" ? status.state === "overridden"
        : status.state !== "add";
  if (!valid) throw new Error(`The ${action} action is not available for this workflow`);
}

export async function buildPlan(client: Octokit, input: { repository: string; catalog: Catalog; request: PlanRequest; repositoryExists: boolean }) {
  const [owner, repo, extra] = input.repository.split("/");
  if (!owner || repo !== ".agents" || extra) throw new Error("Invalid .agents repository selection");
  const current: RepositorySnapshot = input.repositoryExists ? await repositorySnapshot(client, owner) : { sha: "", files: {}, manifest: null };
  let changes: Change[];
  let intent: Plan["intent"];
  if (input.request.target === "workflow") {
    const request = input.request;
    const selected = input.catalog.workflows.find((workflow) => workflow.id === request.workflow);
    if (!selected) throw new Error("Invalid workflow selection");
    const status: WorkflowStatus = input.repositoryExists ? classifyWorkflow(selected, input.catalog, current) : { id: selected.id, state: "add", sourceSha: selected.sourceSha };
    validateWorkflowAction(status, request.action);
    const ids = new Set(Object.keys(current.manifest?.workflows ?? {}));
    if (request.action === "remove") ids.delete(selected.id); else ids.add(selected.id);
    const settings = await currentText(client, owner, current, "settings.yml") ?? undefined;
    const sourceAlreadyConfigured = summarizeSettings(settings ?? "").sources.some((source) => source.github === input.catalog.sourceRepository);
    const removedSourceOwner = request.action === "remove" && current.manifest?.workflows[selected.id]?.managesSource === true;
    const selections = input.catalog.workflows.filter((workflow) => ids.has(workflow.id)).map((bundle) => ({
      bundle,
      strategy: bundle.id === selected.id
        ? request.strategy ?? current.manifest?.workflows[bundle.id]?.strategy ?? "catalog-reference"
        : current.manifest?.workflows[bundle.id]?.strategy ?? "catalog-reference",
      managesSource: current.manifest?.workflows[bundle.id]?.managesSource ?? (bundle.id === selected.id && !sourceAlreadyConfigured),
    }));
    if (removedSourceOwner && !selections.some((selection) => selection.managesSource)) {
      const successor = selections.find((selection) => selection.strategy === "catalog-reference");
      if (successor) successor.managesSource = true;
    }
    const removeManagedCatalogSource = removedSourceOwner && !selections.some((selection) => selection.strategy === "catalog-reference");
    const desired = selections.length ? await desiredWorkflowFiles(selections, settings, removeManagedCatalogSource) : [];
    if (settings !== undefined && current.manifest?.files["settings.yml"] && !desired.some((file) => file.path === "settings.yml")) {
      const content = removeManagedCatalogSource ? unpinGitHubSource(settings, input.catalog.sourceRepository) : settings;
      desired.push({ path: "settings.yml", content, mode: "100644", sha256: await sha256(content) });
    }
    changes = input.repositoryExists ? await diff(client, owner, current, desired) : desired.map((file) => ({ path: file.path, action: "add", before: null, after: file.content, mode: file.mode }));
    intent = { target: "workflow", id: selected.id, action: request.action };
  } else {
    const request = input.request;
    if (!input.repositoryExists) throw new Error("No .agents repository exists");
    const raw = await currentText(client, owner, current, "settings.yml");
    if (raw === null) throw new Error("settings.yml does not exist");
    const summary = summarizeSettings(raw);
    if (!summary.valid) throw new Error("settings.yml is invalid");
    const source = summary.sources.find((candidate) => candidate.id === request.source);
    if (!source) throw new Error("The selected source no longer exists");
    const dependents = Object.entries(current.manifest?.workflows ?? {}).filter(([, workflow]) => workflow.source.github === source.github).map(([id]) => id);
    if (request.action === "remove" && dependents.length) throw new Error(`Remove ${dependents.join(", ")} before removing this source`);
    const freshness = request.action === "update" && source.github ? await sourceFreshness(client, source.github, source.ref) : null;
    const latestRef = freshness?.latestRef;
    if (request.action === "update" && (!source.github || !latestRef)) throw new Error("The latest GitHub revision is unavailable");
    const after = request.action === "remove" ? removeSource(raw, source.id) : setSourceRef(raw, source.id, latestRef!);
    const desiredManifest = current.manifest ? structuredClone(current.manifest) : null;
    if (desiredManifest?.files["settings.yml"]) {
      desiredManifest.files["settings.yml"].sha256 = await sha256(after);
      for (const workflow of desiredManifest.files["settings.yml"].workflows) {
        if (source.github && desiredManifest.workflows[workflow]?.source.github === source.github) {
          desiredManifest.workflows[workflow].source.ref = latestRef!;
          desiredManifest.workflows[workflow].sourceSha = freshness!.latestSha!;
          desiredManifest.workflows[workflow].files["settings.yml"] = desiredManifest.files["settings.yml"].sha256;
        }
      }
    }
    changes = [{ path: "settings.yml", action: "update", before: raw, after, mode: "100644" }];
    if (desiredManifest) {
      const before = await currentText(client, owner, current, manifestPath);
      const manifest = `${JSON.stringify(desiredManifest, null, 2)}\n`;
      if (before !== manifest) changes.push({ path: manifestPath, action: "update", before, after: manifest, mode: "100644" });
    }
    intent = { target: "source", id: source.id, action: request.action };
  }
  if (!changes.length) throw new Error("No repository changes are required");
  return {
    version: 1,
    repository: input.repository,
    baseSha: input.repositoryExists ? current.sha : null,
    sourceSha: input.catalog.sourceSha,
    intent,
    ...(!input.repositoryExists && input.request.target === "workflow" ? { create: { private: input.request.private === true, accountType: input.request.accountType ?? "Organization" } } : {}),
    changes,
    warnings: [],
    expiresAt: Date.now() + 10 * 60_000,
  } satisfies Plan;
}

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return base64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}
export async function signPlan(plan: Plan, secret: string) { const payload = base64url(new TextEncoder().encode(JSON.stringify(plan))); return `${payload}.${await hmac(secret, payload)}`; }
export async function verifyPlan(token: string, secret: string): Promise<Plan> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || !await secureEqual(await hmac(secret, payload), signature)) throw new Error("Invalid plan token");
  const plan = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0)))) as Plan;
  if (plan.version !== 1 || plan.expiresAt < Date.now()) throw new Error("Plan expired");
  return plan;
}

async function createRepositoryFromPlan(client: Octokit, plan: Plan) {
  const [owner] = plan.repository.split("/");
  const create = plan.create!;
  if (plan.changes.some((change) => change.action !== "add" || change.after === null)) throw new Error("A repository creation plan may only add files");
  if (create.accountType === "Organization") await client.request("POST /orgs/{org}/repos", { org: owner, name: ".agents", private: create.private, auto_init: false });
  else await client.request("POST /user/repos", { name: ".agents", private: create.private, auto_init: false });
  const blobs = await Promise.all(plan.changes.map(async (change) => ({ ...change, sha: String((await client.request("POST /repos/{owner}/{repo}/git/blobs", { owner, repo: ".agents", content: change.after!, encoding: "utf-8" })).data.sha) })));
  const createdTree = await client.request("POST /repos/{owner}/{repo}/git/trees", { owner, repo: ".agents", tree: blobs.map((file) => ({ path: file.path, mode: file.mode, type: "blob" as const, sha: file.sha })) });
  const commit = await client.request("POST /repos/{owner}/{repo}/git/commits", { owner, repo: ".agents", message: "chore: manage agents with AI Outfitter", tree: createdTree.data.sha, parents: [] });
  await client.request("POST /repos/{owner}/{repo}/git/refs", { owner, repo: ".agents", ref: "refs/heads/main", sha: commit.data.sha });
  return { mode: "direct" as const, commitUrl: commit.data.html_url };
}

export async function applyPlan(client: Octokit, plan: Plan, mode: "pull-request" | "direct") {
  if (plan.baseSha === null) return createRepositoryFromPlan(client, plan);
  const [owner, repo] = plan.repository.split("/");
  const metadata = await client.request("GET /repos/{owner}/{repo}", { owner, repo });
  const branch = String(metadata.data.default_branch);
  const head = await client.request("GET /repos/{owner}/{repo}/git/ref/{ref}", { owner, repo, ref: `heads/${branch}` });
  if (head.data.object.sha !== plan.baseSha) throw new Error("Repository changed after preview; create a new plan");
  const baseCommit = await client.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { owner, repo, commit_sha: plan.baseSha });
  const entries = plan.changes.map((change) => change.action === "delete" ? { path: change.path, mode: change.mode, type: "blob" as const, sha: null } : { path: change.path, mode: change.mode, type: "blob" as const, content: change.after! });
  const createdTree = await client.request("POST /repos/{owner}/{repo}/git/trees", { owner, repo, base_tree: baseCommit.data.tree.sha, tree: entries });
  const commit = await client.request("POST /repos/{owner}/{repo}/git/commits", { owner, repo, message: "chore: manage agents with AI Outfitter", tree: createdTree.data.sha, parents: [plan.baseSha] });
  if (mode === "direct") {
    await client.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", { owner, repo, ref: `heads/${branch}`, sha: commit.data.sha, force: false });
    return { mode, commitUrl: commit.data.html_url };
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(plan.changes)));
  const feature = `outfitter/manage-${base64url(digest).slice(0, 10).toLowerCase()}`;
  try { await client.request("POST /repos/{owner}/{repo}/git/refs", { owner, repo, ref: `refs/heads/${feature}`, sha: commit.data.sha }); }
  catch (error) { if ((error as { status?: number }).status !== 422) throw error; }
  const existing = await client.request("GET /repos/{owner}/{repo}/pulls", { owner, repo, head: `${owner}:${feature}`, state: "open" });
  if (existing.data[0]) return { mode, pullRequestUrl: existing.data[0].html_url };
  const pull = await client.request("POST /repos/{owner}/{repo}/pulls", { owner, repo, head: feature, base: branch, title: "Manage agents with AI Outfitter", body: `Structured update from ai-outfitter.com.\n\nCommunity source: \`${plan.sourceSha}\`` });
  return { mode, pullRequestUrl: pull.data.html_url };
}
