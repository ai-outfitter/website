import type { Octokit } from "@octokit/core";
import { base64url } from "./crypto";
import { textBlob, tree } from "./github";
import { classifyWorkflow, normalizeManifest } from "./status";

export type WorkflowState = "add" | "installed" | "outdated" | "overridden";
export type WorkflowStatus = { id: string; state: WorkflowState; action: "add" | "update" | "none"; sourceSha: string; reason?: string };
export type Change = { path: string; action: "add" | "update" | "delete"; before: string | null; after: string | null; mode: "100644" | "100755" };
export type Plan = { version: 1; repository: string; baseSha: string; sourceSha: string; managedRoot: string; changes: Change[]; warnings: string[]; expiresAt: number };
export type BundleFile = { path: string; content: string; mode: "100644" | "100755"; sha256: string; blobSha?: string };
export type WorkflowBundle = { id: string; title?: string; description?: string; sourceSha: string; files: BundleFile[] };
export type Catalog = { sourceSha: string; workflows: WorkflowBundle[] };
export type ManagedManifest = { version: 2; catalogSha: string; workflows: Record<string, { sourceSha: string; files: Record<string, string> }>; files: Record<string, { sha256: string; workflows: string[] }> };
export type RepositorySnapshot = { sha: string; files: Record<string, { mode: string; blobSha: string; sha256?: string }>; manifest: ManagedManifest | null };
const safe = /^(?:agents|skills|prompts|workflows|\.outfitter)\/[A-Za-z0-9._/-]+$/;
const manifestPath = ".outfitter/website-managed.json";
const omittedComposition = ".outfitter/workflow-composition.json";

export async function sha256(content: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function catalogFrom(workflows: WorkflowBundle[]): Catalog {
  const sourceSha = workflows[0]?.sourceSha ?? "";
  if (workflows.some((workflow) => workflow.sourceSha !== sourceSha)) throw new Error("Catalog workflows must share one source revision");
  return { sourceSha, workflows };
}
export async function managedBundleFiles(input: WorkflowBundle | WorkflowBundle[]): Promise<BundleFile[]> {
  const workflows = Array.isArray(input) ? input : [input];
  if (!workflows.length) throw new Error("At least one workflow is required");
  const union = new Map<string, BundleFile>();
  const owners = new Map<string, string[]>();
  for (const workflow of workflows) for (const file of workflow.files) {
    if (file.path === omittedComposition) continue;
    const previous = union.get(file.path);
    if (previous && (previous.content !== file.content || previous.mode !== file.mode)) throw new Error(`Catalog collision at ${file.path}`);
    union.set(file.path, file);
    owners.set(file.path, [...new Set([...(owners.get(file.path) ?? []), workflow.id])].sort());
  }
  const workflowRecords = Object.fromEntries([...workflows].sort((a, b) => a.id.localeCompare(b.id)).map((workflow) => [workflow.id, { sourceSha: workflow.sourceSha, files: Object.fromEntries(workflow.files.filter((file) => file.path !== omittedComposition).map((file) => [file.path, file.sha256]).sort(([a], [b]) => a.localeCompare(b))) }]));
  const fileRecords = Object.fromEntries([...union].sort(([a], [b]) => a.localeCompare(b)).map(([path, file]) => [path, { sha256: file.sha256, workflows: owners.get(path)! }]));
  const content = `${JSON.stringify({ version: 2, catalogSha: workflows[0].sourceSha, workflows: workflowRecords, files: fileRecords } satisfies ManagedManifest, null, 2)}\n`;
  return [...[...union.values()].sort((a, b) => a.path.localeCompare(b.path)), { path: manifestPath, content, mode: "100644", sha256: await sha256(content) }];
}

export async function repositorySnapshot(client: Octokit, owner: string, repo: string, managedRoot = ""): Promise<RepositorySnapshot> {
  const listing = await tree(client, owner, repo, "HEAD");
  if (listing.truncated) throw new Error("Repository tree is too large to manage safely");
  const prefix = managedRoot ? `${managedRoot}/` : "";
  const files: RepositorySnapshot["files"] = Object.fromEntries(listing.entries.filter((entry) => entry.type === "blob" && entry.path.startsWith(prefix)).map((entry) => [entry.path.slice(prefix.length), { mode: entry.mode, blobSha: entry.sha }]));
  const entry = listing.entries.find((candidate) => candidate.path === `${prefix}${manifestPath}` && candidate.type === "blob");
  let manifest: ManagedManifest | null = null;
  if (entry) try { manifest = normalizeManifest(JSON.parse(await textBlob(client, owner, repo, entry.sha))); } catch { manifest = null; }
  for (const path of Object.keys(manifest?.files ?? {})) if (files[path]) files[path].sha256 = await sha256(await textBlob(client, owner, repo, files[path].blobSha));
  return { sha: listing.sha, files, manifest };
}
export function workflowStatuses(catalog: Catalog, snapshot: RepositorySnapshot) { return catalog.workflows.map((workflow) => classifyWorkflow(workflow, catalog, snapshot)); }

export async function buildPlan(client: Octokit, input: { repository: string; managedRoot: string; catalog: Catalog; workflow?: string; deletes?: string[] }) {
  const parts = input.repository.split("/");
  const [owner, repo] = parts;
  const selected = input.workflow && input.catalog.workflows.find((workflow) => workflow.id === input.workflow);
  const validRoot = repo === ".agents" ? input.managedRoot === "" : input.managedRoot === ".agents";
  if (parts.length !== 2 || !owner || !repo || !validRoot || (input.workflow && !selected) || input.catalog.workflows.some((workflow) => workflow.files.some((file) => !safe.test(file.path)))) throw new Error("Invalid workflow or .agents repository selection");
  const current = await repositorySnapshot(client, owner, repo, input.managedRoot);
  const statuses = workflowStatuses(input.catalog, current);
  const installedIds = new Set(Object.keys(current.manifest?.workflows ?? {}));
  if (!selected) for (const status of statuses) if (status.state !== "add") installedIds.add(status.id);
  for (const requested of input.deletes ?? []) {
    const prefix = input.managedRoot ? `${input.managedRoot}/` : "";
    if (prefix && !requested.startsWith(prefix)) throw new Error("Invalid managed resource removal");
    const relative = requested.slice(prefix.length);
    if (!safe.test(relative) || relative.includes("..")) throw new Error("Invalid managed resource removal");
    const records = Object.entries(current.manifest?.files ?? {}).filter(([path]) => path === relative || path.startsWith(`${relative}/`));
    if (!records.length) throw new Error("Invalid managed resource removal");
    for (const [, record] of records) for (const workflow of record.workflows) installedIds.delete(workflow);
  }
  if (selected) installedIds.add(selected.id);
  const overridden = statuses.filter((status) => installedIds.has(status.id) && status.state === "overridden");
  if (overridden.length) throw new Error(`Updates overlap overridden workflows: ${overridden.map((status) => status.id).join(", ")}`);
  const bundles = input.catalog.workflows.filter((workflow) => installedIds.has(workflow.id));
  if (!bundles.length && !(input.deletes?.length && current.manifest)) throw new Error("No workflows are selected");
  const desired = bundles.length ? await managedBundleFiles(bundles) : [];
  const desiredPaths = new Set(desired.map((file) => file.path));
  const changes: Change[] = [];
  for (const file of desired) {
    const existing = current.files[file.path];
    const before = existing ? await textBlob(client, owner, repo, existing.blobSha) : null;
    if (before !== file.content || existing?.mode !== file.mode) changes.push({ path: `${input.managedRoot ? `${input.managedRoot}/` : ""}${file.path}`, action: existing ? "update" : "add", before, after: file.content, mode: file.mode });
  }
  for (const [path, record] of Object.entries(current.manifest?.files ?? {})) {
    if (desiredPaths.has(path)) continue;
    const existing = current.files[path];
    if (existing?.sha256 === record.sha256) changes.push({ path: `${input.managedRoot ? `${input.managedRoot}/` : ""}${path}`, action: "delete", before: await textBlob(client, owner, repo, existing.blobSha), after: null, mode: existing.mode === "100755" ? "100755" : "100644" });
  }
  if (!bundles.length && current.files[manifestPath]) changes.push({ path: `${input.managedRoot ? `${input.managedRoot}/` : ""}${manifestPath}`, action: "delete", before: await textBlob(client, owner, repo, current.files[manifestPath].blobSha), after: null, mode: "100644" });
  if (!changes.length) throw new Error("No repository changes are required");
  return { version: 1, repository: input.repository, baseSha: current.sha, sourceSha: input.catalog.sourceSha, managedRoot: input.managedRoot, changes, warnings: [], expiresAt: Date.now() + 10 * 60_000 } satisfies Plan;
}

async function hmac(secret: string, value: string) { const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]); return base64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))); }
export async function signPlan(plan: Plan, secret: string) { const payload = base64url(new TextEncoder().encode(JSON.stringify(plan))); return `${payload}.${await hmac(secret, payload)}`; }
export async function verifyPlan(token: string, secret: string): Promise<Plan> {
  const [payload, signature, extra] = token.split("."); if (!payload || !signature || extra || await hmac(secret, payload) !== signature) throw new Error("Invalid plan token");
  const plan = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0)))) as Plan;
  if (plan.version !== 1 || plan.expiresAt < Date.now()) throw new Error("Plan expired"); return plan;
}

export async function applyPlan(client: Octokit, plan: Plan, mode: "pull-request" | "direct") {
  const [owner, repo] = plan.repository.split("/");
  const metadata = await client.request("GET /repos/{owner}/{repo}", { owner, repo });
  const branch = String(metadata.data.default_branch);
  const head = await client.request("GET /repos/{owner}/{repo}/git/ref/{ref}", { owner, repo, ref: `heads/${branch}` });
  if (head.data.object.sha !== plan.baseSha) throw new Error("Repository changed after preview; create a new plan");
  const baseCommit = await client.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { owner, repo, commit_sha: plan.baseSha });
  const entries = await Promise.all(plan.changes.map(async (change) => change.action === "delete" ? { path: change.path, mode: change.mode, type: "blob" as const, sha: null } : { path: change.path, mode: change.mode, type: "blob" as const, content: change.after! }));
  const createdTree = await client.request("POST /repos/{owner}/{repo}/git/trees", { owner, repo, base_tree: baseCommit.data.tree.sha, tree: entries });
  const commit = await client.request("POST /repos/{owner}/{repo}/git/commits", { owner, repo, message: "chore: manage agents with AI Outfitter", tree: createdTree.data.sha, parents: [plan.baseSha] });
  if (mode === "direct") { await client.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", { owner, repo, ref: `heads/${branch}`, sha: commit.data.sha, force: false }); return { mode, commitUrl: commit.data.html_url }; }
  const digest = (await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(plan.changes))));
  const feature = `outfitter/manage-${base64url(digest).slice(0, 10).toLowerCase()}`;
  try { await client.request("POST /repos/{owner}/{repo}/git/refs", { owner, repo, ref: `refs/heads/${feature}`, sha: commit.data.sha }); }
  catch (error) { if ((error as { status?: number }).status !== 422) throw error; }
  const existing = await client.request("GET /repos/{owner}/{repo}/pulls", { owner, repo, head: `${owner}:${feature}`, state: "open" });
  if (existing.data[0]) return { mode, pullRequestUrl: existing.data[0].html_url };
  const pull = await client.request("POST /repos/{owner}/{repo}/pulls", { owner, repo, head: feature, base: branch, title: "Manage agents with AI Outfitter", body: `Structured update from ai-outfitter.com.\n\nCommunity source: \`${plan.sourceSha}\`` });
  return { mode, pullRequestUrl: pull.data.html_url };
}
