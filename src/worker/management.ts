import type { Octokit } from "@octokit/core";
import { base64url, secureEqual } from "./crypto";
import { sourceFreshness, textBlob, tree } from "./github";
import { pinGitHubSource, removeSource, setSourceRef, setWorkflowAcceptance, summarizeSettings } from "./settings";

export type WorkflowState = "available" | "accepted" | "customized" | "needs-attention";
export type WorkflowAction = "accept" | "remove";
export type SourceAction = "update" | "remove";
export type WorkflowStatus = { id: string; state: WorkflowState; sourceSha: string; reason?: string };
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
export type Catalog = { sourceRepository: string; sourceSha: string; sourceRef: string; workflows: WorkflowBundle[] };
export type RepositorySnapshot = { sha: string; files: Record<string, { mode: string; blobSha: string }> };
export type PlanRequest =
  | { target: "workflow"; workflow: string; action: WorkflowAction; private?: boolean; accountType?: "User" | "Organization" }
  | { target: "source"; source: string; action: SourceAction };

export function catalogFrom(workflows: WorkflowBundle[]): Catalog {
  const sourceSha = workflows[0]?.sourceSha ?? "";
  const sourceRepository = workflows[0]?.sourceRepository ?? "";
  if (workflows.some((workflow) => workflow.sourceSha !== sourceSha || workflow.sourceRepository !== sourceRepository)) throw new Error("Catalog workflows must share one source revision");
  return { sourceRepository, sourceSha, sourceRef: "v1.4.0", workflows };
}

export async function repositorySnapshot(client: Octokit, owner: string): Promise<RepositorySnapshot> {
  const listing = await tree(client, owner, "HEAD");
  if (listing.truncated) throw new Error("Repository tree is too large to manage safely");
  const files: RepositorySnapshot["files"] = Object.fromEntries(listing.entries.filter((entry) => entry.type === "blob").map((entry) => [entry.path, { mode: entry.mode, blobSha: entry.sha }]));
  return { sha: listing.sha, files };
}

async function currentText(client: Octokit, owner: string, snapshot: RepositorySnapshot, path: string) {
  const entry = snapshot.files[path];
  return entry ? textBlob(client, owner, entry.blobSha) : null;
}

export async function buildPlan(client: Octokit, input: { repository: string; catalog: Catalog; request: PlanRequest; repositoryExists: boolean }) {
  const [owner, repo, extra] = input.repository.split("/");
  if (!owner || repo !== ".agents" || extra) throw new Error("Invalid .agents repository selection");
  const current: RepositorySnapshot = input.repositoryExists ? await repositorySnapshot(client, owner) : { sha: "", files: {} };
  const raw = input.repositoryExists ? await currentText(client, owner, current, "settings.yml") : null;
  if (raw !== null && !summarizeSettings(raw).valid) throw new Error("settings.yml is invalid");
  let after: string;
  let intent: Plan["intent"];
  if (input.request.target === "workflow") {
    const request = input.request;
    const selected = input.catalog.workflows.find((workflow) => workflow.id === request.workflow);
    if (!selected) throw new Error("Invalid workflow selection");
    after = setWorkflowAcceptance(raw ?? undefined, selected.id, request.action === "accept");
    if (request.action === "accept") after = pinGitHubSource(after, input.catalog.sourceRepository, input.catalog.sourceRef);
    intent = { target: "workflow", id: selected.id, action: request.action };
  } else {
    const request = input.request;
    if (raw === null) throw new Error("settings.yml does not exist");
    const summary = summarizeSettings(raw);
    if (!summary.valid) throw new Error("settings.yml is invalid");
    const source = summary.sources.find((candidate) => candidate.id === request.source);
    if (!source) throw new Error("The selected source no longer exists");
    const freshness = request.action === "update" && source.github ? await sourceFreshness(client, source.github, source.ref) : null;
    const latestRef = freshness?.latestRef;
    if (request.action === "update" && (!source.github || !latestRef)) throw new Error("The latest GitHub revision is unavailable");
    after = request.action === "remove" ? removeSource(raw, source.id) : setSourceRef(raw, source.id, latestRef!);
    intent = { target: "source", id: source.id, action: request.action };
  }
  if (after === raw) throw new Error("No repository changes are required");
  const changes: Change[] = [{ path: "settings.yml", action: raw === null ? "add" : "update", before: raw, after, mode: "100644" }];
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
