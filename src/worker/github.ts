import { Octokit } from "@octokit/core";
import { userToken } from "./auth";

export type Repository = { id: number; name: string; fullName: string; owner: string; defaultBranch: string; private: boolean; canPush: boolean; managedRoot: string };

export async function github(env: Env, request: Request) { return new Octokit({ auth: await userToken(env, request.headers) }); }

async function allPages<T>(load: (page: number) => Promise<{ data: T[] }>) {
  const items: T[] = [];
  for (let page = 1; ; page += 1) { const response = await load(page); items.push(...response.data); if (response.data.length < 100) return items; }
}

export async function repositories(client: Octokit): Promise<Repository[]> {
  const installations = await allPages<Record<string, unknown>>((page) => client.request("GET /user/installations", { per_page: 100, page }).then((r) => ({ data: (r.data as { installations: Record<string, unknown>[] }).installations })));
  const found: Repository[] = [];
  for (const installation of installations) {
    const repos = await allPages<Record<string, unknown>>((page) => client.request("GET /user/installations/{installation_id}/repositories", { installation_id: Number(installation.id), per_page: 100, page }).then((r) => ({ data: (r.data as { repositories: Record<string, unknown>[] }).repositories })));
    for (const repo of repos) {
      const owner = String((repo.owner as { login?: string })?.login ?? "");
      const name = String(repo.name);
      let managedRoot = name === ".agents" ? "" : ".agents";
      if (name !== ".agents") {
        try { await client.request("GET /repos/{owner}/{repo}/contents/{path}", { owner, repo: name, path: ".agents" }); }
        catch (error) { if ((error as { status?: number }).status === 404) continue; throw error; }
      }
      found.push({ id: Number(repo.id), name, fullName: String(repo.full_name), owner, defaultBranch: String(repo.default_branch), private: Boolean(repo.private), canPush: Boolean((repo.permissions as { push?: boolean })?.push), managedRoot });
    }
  }
  return found.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export async function tree(client: Octokit, owner: string, repo: string, ref: string) {
  const response = await client.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", { owner, repo, tree_sha: ref, recursive: "1" });
  return { sha: String(response.data.sha), truncated: Boolean(response.data.truncated), entries: response.data.tree.map((entry) => ({ path: String(entry.path), mode: String(entry.mode), type: String(entry.type), sha: String(entry.sha) })) };
}

export async function textBlob(client: Octokit, owner: string, repo: string, sha: string) {
  const response = await client.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", { owner, repo, file_sha: sha });
  if (response.data.encoding !== "base64") throw new Error("Unsupported GitHub blob encoding");
  return new TextDecoder().decode(Uint8Array.from(atob(response.data.content.replaceAll("\n", "")), (c) => c.charCodeAt(0)));
}
