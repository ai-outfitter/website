import type { Octokit } from "@octokit/core";
import { base64url } from "./crypto";
import { textBlob, tree } from "./github";

export type Change = { path: string; action: "add" | "update" | "delete"; before: string | null; after: string | null; mode: "100644" | "100755" };
export type Plan = { version: 1; repository: string; baseSha: string; sourceSha: string; managedRoot: string; changes: Change[]; warnings: string[]; expiresAt: number };
const safe = /^(agents|skills|prompts)\/[A-Za-z0-9._/-]+$/;

function rootPath(root: string, path: string) { return root ? `${root}/${path}` : path; }
function selected(path: string, resources: string[]) { return resources.some((resource) => path === resource || path.startsWith(`${resource}/`)); }

export async function buildPlan(client: Octokit, env: Env, input: { repository: string; managedRoot: string; resources: string[]; deletes?: string[] }) {
  const [owner, repo] = input.repository.split("/");
  if (!owner || !repo || (!input.resources.length && !(input.deletes?.length)) || input.resources.some((path) => !safe.test(path))) throw new Error("Invalid resource selection");
  const [sourceOwner, sourceRepo] = env.COMMUNITY_REPOSITORY.split("/");
  const current = await tree(client, owner, repo, "HEAD");
  const source = await tree(client, sourceOwner, sourceRepo, env.COMMUNITY_REF);
  if (current.truncated || source.truncated) throw new Error("Repository tree is too large to manage safely");
  const currentByPath = new Map(current.entries.map((entry) => [entry.path, entry]));
  const changes: Change[] = [];
  for (const entry of source.entries) {
    if (entry.type !== "blob" || !selected(entry.path, input.resources)) continue;
    if (entry.mode !== "100644" && entry.mode !== "100755") throw new Error(`Unsafe source mode at ${entry.path}`);
    const destination = rootPath(input.managedRoot, entry.path);
    const existing = currentByPath.get(destination);
    const after = await textBlob(client, sourceOwner, sourceRepo, entry.sha);
    const before = existing?.type === "blob" ? await textBlob(client, owner, repo, existing.sha) : null;
    if (before !== after) changes.push({ path: destination, action: existing ? "update" : "add", before, after, mode: entry.mode });
  }
  for (const deletion of input.deletes ?? []) {
    const relative = input.managedRoot && deletion.startsWith(`${input.managedRoot}/`) ? deletion.slice(input.managedRoot.length + 1) : deletion;
    if (!safe.test(relative)) throw new Error("Deletion is outside the managed resource roots");
    const matches = current.entries.filter((entry) => entry.type === "blob" && (entry.path === deletion || entry.path.startsWith(`${deletion}/`)));
    if (!matches.length) throw new Error(`Managed resource does not exist: ${deletion}`);
    const slug = relative.split("/")[1];
    for (const candidate of current.entries.filter((entry) => entry.type === "blob" && !matches.includes(entry) && /\.(md|ya?ml|json)$/.test(entry.path))) {
      const content = await textBlob(client, owner, repo, candidate.sha);
      if (new RegExp(`(^|[\\s/:,[{\"'])${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[\\s/,:\\]}\"'])`, "m").test(content)) throw new Error(`${deletion} is referenced by ${candidate.path}`);
    }
    for (const existing of matches) changes.push({ path: existing.path, action: "delete", before: await textBlob(client, owner, repo, existing.sha), after: null, mode: existing.mode === "100755" ? "100755" : "100644" });
  }
  if (!changes.length) throw new Error("No repository changes are required");
  return { version: 1, repository: input.repository, baseSha: current.sha, sourceSha: source.sha, managedRoot: input.managedRoot, changes, warnings: [], expiresAt: Date.now() + 10 * 60_000 } satisfies Plan;
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
