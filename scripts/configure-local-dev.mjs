import { randomBytes } from "node:crypto";
import { access, chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localEnvironment = resolve(projectRoot, ".dev.vars");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findOwnerEnvironment() {
  let candidate = projectRoot;
  while (dirname(candidate) !== candidate) {
    const environment = resolve(candidate, ".env");
    if (await exists(environment) && await exists(resolve(candidate, "outfitter/README.md"))) return environment;
    candidate = dirname(candidate);
  }
  return null;
}

function parseEnvironment(source) {
  const parsed = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[match[1]] = value;
  }
  return parsed;
}

if (await exists(localEnvironment)) {
  const status = await lstat(localEnvironment);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(".dev.vars must be a regular file, not a symlink");
  }
  if ((status.mode & 0o777) !== 0o600) await chmod(localEnvironment, 0o600);
  console.log("Keeping existing .dev.vars.");
  process.exit(0);
}

const ownerEnvironment = await findOwnerEnvironment();
if (!ownerEnvironment) throw new Error("AI Outfitter owner .env was not found");
const values = { ...parseEnvironment(await readFile(ownerEnvironment, "utf8")), ...process.env };
if (!values.GH_TOKEN_RO) {
  throw new Error("GH_TOKEN_RO is required in the environment or the AI Outfitter owner .env file");
}

await writeFile(localEnvironment, [
  `LOCAL_GITHUB_TOKEN=${values.GH_TOKEN_RO}`,
  "LOCAL_GITHUB_AUTH=true",
  "LOCAL_GITHUB_ACCOUNTS=ai-outfitter",
  `AGENTS_PLAN_SIGNING_KEY=${randomBytes(32).toString("hex")}`,
  "",
].join("\n"), { mode: 0o600, flag: "wx" });

console.log("Created .dev.vars from GH_TOKEN_RO in the AI Outfitter owner .env.");
