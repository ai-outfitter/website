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

export type SourceFreshness = {
  status: "current" | "outdated" | "ahead" | "diverged" | "unpinned" | "unavailable" | "invalid" | "local-only";
  currentRef?: string;
  currentSha?: string;
  latestRef?: string;
  latestSha?: string;
  latestKind?: "release" | "default-branch";
  defaultBranch?: string;
  repositoryUrl?: string;
  reason?: string;
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
      const requestHost = request.headers.get("host") ?? new URL(request.url).host;
      if (parsed.protocol !== "http:" || parsed.host !== requestHost) return null;
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

function githubRepository(value: string) {
  const match = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  return match ? { owner: match[1], repo: match[2] } : null;
}

export async function sourceFreshness(client: Octokit, github: string, ref?: string): Promise<SourceFreshness> {
  const repository = githubRepository(github);
  if (!repository) return { status: "invalid", reason: "GitHub sources must use owner/repository syntax." };
  const repositoryUrl = `https://github.com/${repository.owner}/${repository.repo}`;
  try {
    const metadata = await client.request("GET /repos/{owner}/{repo}", repository);
    const defaultBranch = String(metadata.data.default_branch);
    let latestRef: string;
    let latestSha: string;
    let latestKind: SourceFreshness["latestKind"];
    try {
      const release = await client.request("GET /repos/{owner}/{repo}/releases/latest", repository);
      latestRef = String(release.data.tag_name);
      const commit = await client.request("GET /repos/{owner}/{repo}/commits/{ref}", { ...repository, ref: latestRef });
      latestSha = String(commit.data.sha);
      latestKind = "release";
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      const commit = await client.request("GET /repos/{owner}/{repo}/commits/{ref}", { ...repository, ref: defaultBranch });
      latestSha = String(commit.data.sha);
      latestRef = latestSha;
      latestKind = "default-branch";
    }
    const common = { latestRef, latestSha, latestKind, defaultBranch, repositoryUrl };
    if (!ref) return { status: "unpinned", ...common };
    const configured = await client.request("GET /repos/{owner}/{repo}/commits/{ref}", { ...repository, ref });
    const currentSha = String(configured.data.sha);
    if (currentSha === latestSha) return { status: "current", currentRef: ref, currentSha, ...common };
    const comparison = await client.request("GET /repos/{owner}/{repo}/compare/{basehead}", { ...repository, basehead: `${currentSha}...${latestSha}` });
    const status = comparison.data.status === "ahead" ? "outdated" : comparison.data.status === "behind" ? "ahead" : "diverged";
    return { status, currentRef: ref, currentSha, ...common };
  } catch (error) {
    return { status: "unavailable", currentRef: ref, repositoryUrl, reason: error instanceof Error ? error.message : "GitHub could not resolve this source." };
  }
}
