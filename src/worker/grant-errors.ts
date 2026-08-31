export class GitHubGrantRetryableError extends Error {
  constructor() { super("GitHub authorization is temporarily unavailable"); this.name = "GitHubGrantRetryableError"; }
}

export function refreshResponseClass(status: number): "success" | "retryable" | "terminal" {
  if (status === 200) return "success";
  if (status === 429 || status >= 500 || status < 400) return "retryable";
  return "terminal";
}
