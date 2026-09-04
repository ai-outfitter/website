interface Env {
  ASSETS: Fetcher;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_USER_TOKEN_ENCRYPTION_KEY: string;
  AGENTS_PLAN_SIGNING_KEY: string;
  GITHUB_APP_SLUG: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_WEBHOOK_SECRET: string;
  RUNNER_INSTALLATION_ID?: string;
  TRIGGER_LABEL?: string;
  TRIGGER_ASSIGNEE?: string;
  LOCAL_GITHUB_AUTH?: string;
  LOCAL_GITHUB_ACCOUNTS?: string;
  LOCAL_GITHUB_TOKEN?: string;
  LOCAL_DEV_PORT?: string;
  GITHUB_USER_GRANTS: DurableObjectNamespace<import("./worker/grant").GitHubUserGrant>;
}
