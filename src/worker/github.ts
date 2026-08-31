import { Octokit } from "@octokit/core";
import { userToken } from "./auth";

export type Repository = { id: number; name: string; fullName: string; owner: string; defaultBranch: string; private: boolean; canPush: boolean; managedRoot: string };
export type Account = { login: string; type: "User" | "Organization"; installationId: number; hasAgentsRepository: boolean };

export async function github(env: Env, request: Request) { return new Octokit({ auth: await userToken(env, request.headers) }); }

async function allPages<T>(load: (page: number) => Promise<{ data: T[] }>) {
  const items: T[] = [];
  for (let page = 1; ; page += 1) { const response = await load(page); items.push(...response.data); if (response.data.length < 100) return items; }
}

export async function installations(client: Octokit) {
  return allPages<Record<string, unknown>>((page) => client.request("GET /user/installations", { per_page: 100, page }).then((r) => ({ data: (r.data as { installations: Record<string, unknown>[] }).installations })));
}

export async function repositories(client: Octokit): Promise<Repository[]> {
  const installed = await installations(client);
  const found: Repository[] = [];
  for (const installation of installed) {
    const repos = await allPages<Record<string, unknown>>((page) => client.request("GET /user/installations/{installation_id}/repositories", { installation_id: Number(installation.id), per_page: 100, page }).then((r) => ({ data: (r.data as { repositories: Record<string, unknown>[] }).repositories })));
    for (const repo of repos) {
      const owner = String((repo.owner as { login?: string })?.login ?? "");
      const name = String(repo.name);
      if (name !== ".agents") continue;
      found.push({ id: Number(repo.id), name, fullName: String(repo.full_name), owner, defaultBranch: String(repo.default_branch), private: Boolean(repo.private), canPush: Boolean((repo.permissions as { push?: boolean })?.push), managedRoot: "" });
    }
  }
  return found.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export async function accounts(client: Octokit, repos: Repository[]): Promise<Account[]> {
  const viewer = await client.request("GET /user");
  const installed = await installations(client);
  const values = new Map<string, Account>();
  const personalInstallation = installed.find((installation) => (installation.account as { login?: string } | undefined)?.login === viewer.data.login);
  if (personalInstallation) values.set(String(viewer.data.login), { login: String(viewer.data.login), type: "User", installationId: Number(personalInstallation.id), hasAgentsRepository: repos.some((repo) => repo.owner === viewer.data.login) });
  for (const installation of installed) {
    const account = installation.account as { login?: string; type?: string } | undefined;
    if (!account?.login || (account.type !== "User" && account.type !== "Organization")) continue;
    values.set(account.login, { login: account.login, type: account.type, installationId: Number(installation.id), hasAgentsRepository: repos.some((repo) => repo.owner === account.login) });
  }
  return [...values.values()].sort((left, right) => left.login.localeCompare(right.login));
}

export async function repository(client: Octokit, owner: string) {
  const response = await client.request("GET /repos/{owner}/{repo}", { owner, repo: ".agents" });
  return { id: Number(response.data.id), name: ".agents", fullName: String(response.data.full_name), owner, defaultBranch: String(response.data.default_branch), private: Boolean(response.data.private), canPush: Boolean(response.data.permissions?.push), managedRoot: "" } satisfies Repository;
}

export async function createAgentsRepository(client: Octokit, input: { account: Account; private: boolean; files: { path: string; content: string; mode: "100644" | "100755" }[]; sourceSha: string }) {
  const create = input.account.type === "Organization"
    ? await client.request("POST /orgs/{org}/repos", { org: input.account.login, name: ".agents", private: input.private, auto_init: false })
    : await client.request("POST /user/repos", { name: ".agents", private: input.private, auto_init: false });
  const owner = input.account.login; const repo = String(create.data.name);
  const blobs = await Promise.all(input.files.map(async (file) => ({ ...file, sha: String((await client.request("POST /repos/{owner}/{repo}/git/blobs", { owner, repo, content: file.content, encoding: "utf-8" })).data.sha) })));
  const createdTree = await client.request("POST /repos/{owner}/{repo}/git/trees", { owner, repo, tree: blobs.map((file) => ({ path: file.path, mode: file.mode, type: "blob" as const, sha: file.sha })) });
  const commit = await client.request("POST /repos/{owner}/{repo}/git/commits", { owner, repo, message: `chore: install ${input.files.length} workflow files\n\nCommunity source: ${input.sourceSha}`, tree: createdTree.data.sha, parents: [] });
  await client.request("POST /repos/{owner}/{repo}/git/refs", { owner, repo, ref: "refs/heads/main", sha: commit.data.sha });
  return { repository: `${owner}/${repo}`, commitUrl: commit.data.html_url };
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
