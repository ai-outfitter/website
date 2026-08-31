import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function repositoriesRoot() {
  let candidate = projectRoot;
  while (dirname(candidate) !== candidate) {
    if (process.env.COMMUNITY_PROFILES_DIR || (process.env.OUTFITTER_CLI || (candidate.endsWith("ai-outfitter") && candidate !== projectRoot))) return candidate;
    candidate = dirname(candidate);
  }
  throw new Error("Set COMMUNITY_PROFILES_DIR and OUTFITTER_CLI when repository siblings are unavailable.");
}
const repositoryRoot = repositoriesRoot();
const community = resolve(process.env.COMMUNITY_PROFILES_DIR || join(repositoryRoot, "community-profiles"));
const outfitter = process.env.OUTFITTER_CLI || "outfitter";
const scratch = await mkdtemp(join(tmpdir(), "website-workflows-"));

async function files(root, current = root) {
  const found = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) found.push(...await files(root, path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

try {
  await mkdir(join(scratch, "home"));
  await mkdir(join(scratch, "project"));
  await symlink(community, join(scratch, "project", ".agents"));
  const run = (...args) => execFileSync(outfitter, args, {
    cwd: join(scratch, "project"), env: { ...process.env, HOME: join(scratch, "home") }, stdio: "inherit",
  });
  run("validate", "--strict");
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: community, encoding: "utf8" }).trim();
  const ids = (await readdir(join(community, "workflows"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const catalog = [];
  for (const id of ids) {
    const output = join(scratch, "exports", id);
    run("dump", "--workflow", id, "--out", output);
    const root = join(output, ".agents");
    const declaration = parse(await readFile(join(community, "workflows", id, "workflow.yaml"), "utf8"));
    const bundledFiles = [];
    for (const path of (await files(root)).sort()) {
      const content = await readFile(path, "utf8");
      bundledFiles.push({ path: relative(root, path).replaceAll("\\", "/"), content, mode: "100644", sha256: createHash("sha256").update(content).digest("hex") });
    }
    catalog.push({ id, title: declaration.title, description: declaration.description, sourceSha, files: bundledFiles });
  }
  await mkdir(join(projectRoot, "src/generated"), { recursive: true });
  await writeFile(join(projectRoot, "src/generated/workflow-catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
