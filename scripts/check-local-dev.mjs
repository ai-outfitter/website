import { lstat, readFile } from "node:fs/promises";

function parseEnvironment(source) {
  return Object.fromEntries(source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error(`Invalid .dev.vars line: ${line}`);
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return [key, value];
    }));
}

function required(values, key) {
  const value = values[key]?.trim();
  if (!value) throw new Error(`${key} is required in .dev.vars`);
  return value;
}

async function main() {
  const environment = new URL("../.dev.vars", import.meta.url);
  let source;
  try {
    const status = await lstat(environment);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error(".dev.vars must be a regular file, not a symlink");
    }
    if ((status.mode & 0o777) !== 0o600) {
      throw new Error(".dev.vars permissions must be 0600; run npm run dev:configure");
    }
    source = await readFile(environment, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(".dev.vars is missing; copy .dev.vars.example and add a GitHub PAT");
    }
    throw error;
  }

  const values = parseEnvironment(source);
  if (values.LOCAL_GITHUB_AUTH !== "true") throw new Error("LOCAL_GITHUB_AUTH must be true in .dev.vars");
  const token = required(values, "LOCAL_GITHUB_TOKEN");
  const signingKey = required(values, "AGENTS_PLAN_SIGNING_KEY");
  if (signingKey.startsWith("replace-with-")) throw new Error("Replace the example AGENTS_PLAN_SIGNING_KEY in .dev.vars");

  const response = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "ai-outfitter-website-local-dev",
      "x-github-api-version": "2022-11-28",
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body.message === "string" ? body.message : `HTTP ${response.status}`;
    throw new Error(`GitHub rejected LOCAL_GITHUB_TOKEN: ${message}`);
  }
  if (!body || typeof body.login !== "string") throw new Error("GitHub returned an invalid authenticated-user response");

  console.log(`Local GitHub PAT authenticates as ${body.login}.`);
}

main().catch((error) => {
  console.error(`Local development check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
