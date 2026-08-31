import { Octokit } from "@octokit/core";
import { userToken } from "./auth";

declare const __LOCAL_PAT_DEV__: boolean;

export type Repository = {
  id: number;
  fullName: string;
  owner: string;
  defaultBranch: string;
  private: boolean;
  canPush: boolean;
};

export type Account = {
  login: string;
  type: "User" | "Organization";
  installationId: number | null;
  repository: Repository | null;
  updatedAt?: string;
};

type Installation = {
  id: number;
  account?: { login?: string; type?: string };
  updated_at?: string;
};

export async function github(env: Env, request: Request) {
  return new Octokit({ auth: localGitHubToken(env, request) ?? await userToken(env, request.headers) });
}

export function localGitHubToken(
  env: Env,
  request: Request,
  localRuntime = typeof __LOCAL_PAT_DEV__ !== "undefined" && __LOCAL_PAT_DEV__ === true,
) {
  if (env.LOCAL_GITHUB_AUTH !== "true") return null;
  if (!localRuntime) return null;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const parsed = new URL(origin);
      const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
      if (!loopback || parsed.protocol !== "http:" || parsed.port !== env.LOCAL_DEV_PORT) return null;
    } catch {
      return null;
    }
  }
  const token = env.LOCAL_GITHUB_TOKEN?.trim();
  return token || null;
}

async function allPages<T>(load: (page: number) => Promise<T[]>): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const values = await load(page);
    items.push(...values);
    if (values.length < 100) return items;
  }
}

export async function installations(client: Octokit): Promise<Installation[]> {
  return allPages(async (page) => {
    const response = await client.request("GET /user/installations", { per_page: 100, page });
    return response.data.installations as Installation[];
  });
}

async function installationAgentsRepository(client: Octokit, owner: string): Promise<Repository | null> {
  try {
    return await repository(client, owner);
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

export async function accounts(client: Octokit, options: { repositories?: boolean } = {}): Promise<Account[]> {
  const [viewer, installed] = await Promise.all([
    client.request("GET /user"),
    installations(client),
  ]);
  const values = new Map<string, Account>();

  for (const installation of installed) {
    const login = installation.account?.login;
    const type = installation.account?.type;
    if (!login || (type !== "User" && type !== "Organization")) continue;
    values.set(login, {
      login,
      type,
      installationId: installation.id,
      repository: options.repositories === false ? null : await installationAgentsRepository(client, login),
      updatedAt: installation.updated_at,
    });
  }

  const personal = values.get(String(viewer.data.login));
  if (personal) values.set(personal.login, { ...personal, type: "User" });
  return [...values.values()].sort((left, right) => left.login.localeCompare(right.login));
}

type Viewer = { id: number; login: string; name?: string | null; email?: string | null };

export async function tokenIdentity(client: Octokit): Promise<Viewer> {
  const response = await client.request("GET /user");
  return {
    id: Number(response.data.id),
    login: String(response.data.login),
    name: response.data.name == null ? null : String(response.data.name),
    email: response.data.email == null ? null : String(response.data.email),
  };
}

async function tokenOrganizations(client: Octokit) {
  try {
    return await allPages(async (page) => {
      const response = await client.request("GET /user/orgs", { per_page: 100, page });
      return response.data;
    });
  } catch (error) {
    if ((error as { status?: number }).status === 403) return [];
    throw error;
  }
}

export async function tokenAccounts(client: Octokit, configured = "", options: { repositories?: boolean } = {}): Promise<Account[]> {
  const [viewer, organizations] = await Promise.all([
    tokenIdentity(client),
    tokenOrganizations(client),
  ]);
  const values = new Map<string, Account>([
    ...configured
      .split(",")
      .map((login) => login.trim())
      .filter(Boolean)
      .map((login) => [login, {
        login,
        type: "Organization" as const,
        installationId: null,
        repository: null,
      }] as const),
    ...organizations.map((organization) => [String(organization.login), {
      login: String(organization.login),
      type: "Organization" as const,
      installationId: null,
      repository: null,
    }] as const),
  ]);
  values.set(viewer.login, {
    login: viewer.login,
    type: "User",
    installationId: null,
    repository: null,
  });
  const sorted = [...values.values()].sort((left, right) => left.login.localeCompare(right.login));
  if (options.repositories === false) return sorted;
  return Promise.all(sorted.map(async (account) => ({
    ...account,
    repository: await installationAgentsRepository(client, account.login),
  })));
}

export async function repository(client: Octokit, owner: string): Promise<Repository> {
  const response = await client.request("GET /repos/{owner}/{repo}", { owner, repo: ".agents" });
  return {
    id: Number(response.data.id),
    fullName: String(response.data.full_name),
    owner,
    defaultBranch: String(response.data.default_branch),
    private: Boolean(response.data.private),
    canPush: Boolean(response.data.permissions?.push),
  };
}

export async function createAgentsRepository(client: Octokit, input: {
  account: Account;
  private: boolean;
  files: { path: string; content: string; mode: "100644" | "100755" }[];
  sourceSha: string;
}) {
  const create = input.account.type === "Organization"
    ? await client.request("POST /orgs/{org}/repos", {
        org: input.account.login,
        name: ".agents",
        private: input.private,
        auto_init: false,
      })
    : await client.request("POST /user/repos", {
        name: ".agents",
        private: input.private,
        auto_init: false,
      });

  const owner = input.account.login;
  const repo = String(create.data.name);
  const blobs = await Promise.all(input.files.map(async (file) => ({
    ...file,
    sha: String((await client.request("POST /repos/{owner}/{repo}/git/blobs", {
      owner,
      repo,
      content: file.content,
      encoding: "utf-8",
    })).data.sha),
  })));
  const createdTree = await client.request("POST /repos/{owner}/{repo}/git/trees", {
    owner,
    repo,
    tree: blobs.map((file) => ({ path: file.path, mode: file.mode, type: "blob" as const, sha: file.sha })),
  });
  const commit = await client.request("POST /repos/{owner}/{repo}/git/commits", {
    owner,
    repo,
    message: `chore: install ${input.files.length} workflow files\n\nCommunity source: ${input.sourceSha}`,
    tree: createdTree.data.sha,
    parents: [],
  });
  await client.request("POST /repos/{owner}/{repo}/git/refs", {
    owner,
    repo,
    ref: "refs/heads/main",
    sha: commit.data.sha,
  });
  return { repository: `${owner}/${repo}`, commitUrl: commit.data.html_url };
}

export async function tree(client: Octokit, owner: string, ref: string) {
  const commit = await client.request("GET /repos/{owner}/{repo}/commits/{ref}", {
    owner,
    repo: ".agents",
    ref,
  });
  const sha = String(commit.data.sha);
  const response = await client.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
    owner,
    repo: ".agents",
    tree_sha: sha,
    recursive: "1",
  });
  return {
    sha,
    truncated: Boolean(response.data.truncated),
    entries: response.data.tree.map((entry) => ({
      path: String(entry.path),
      mode: String(entry.mode),
      type: String(entry.type),
      sha: String(entry.sha),
    })),
  };
}

export async function textBlob(client: Octokit, owner: string, sha: string) {
  const response = await client.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
    owner,
    repo: ".agents",
    file_sha: sha,
  });
  if (response.data.encoding !== "base64") throw new Error("Unsupported GitHub blob encoding");
  return new TextDecoder().decode(Uint8Array.from(atob(response.data.content.replaceAll("\n", "")), (character) => character.charCodeAt(0)));
}
