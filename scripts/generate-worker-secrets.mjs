import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const environment = process.argv[2];
if (environment && !/^[A-Za-z0-9_-]+$/.test(environment)) {
  throw new Error("Environment names may contain only letters, numbers, underscores, and hyphens");
}

const generated = [
  "BETTER_AUTH_SECRET",
  "GITHUB_USER_TOKEN_ENCRYPTION_KEY",
  "AGENTS_PLAN_SIGNING_KEY",
];

function putSecret(name, value) {
  return new Promise((resolve, reject) => {
    const args = ["wrangler", "secret", "put", name];
    if (environment) args.push("--env", environment);
    const child = spawn("npm", ["exec", "--", ...args], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.stdin.end(`${value}\n`);
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`Failed to configure ${name}`)));
  });
}

for (const name of generated) {
  const value = randomBytes(32).toString("base64url");
  await putSecret(name, value);
}

console.log(`Generated and configured ${generated.length} application-owned secrets${environment ? ` for ${environment}` : ""}.`);
console.log("GITHUB_CLIENT_SECRET must still be copied from the GitHub App settings with `wrangler secret put GITHUB_CLIENT_SECRET`.");
