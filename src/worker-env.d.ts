interface Env {
  ASSETS: Fetcher;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_USER_TOKEN_ENCRYPTION_KEY: string;
  AGENTS_PLAN_SIGNING_KEY: string;
  GITHUB_APP_SLUG: string;
  COMMUNITY_REPOSITORY: string;
  COMMUNITY_REF: string;
  GITHUB_USER_GRANTS: DurableObjectNamespace<import("./worker/grant").GitHubUserGrant>;
}
