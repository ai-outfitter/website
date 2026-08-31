import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
let community = resolve(process.env.COMMUNITY_PROFILES_DIR || join(repositoryRoot, "community-profiles"));
const workflowCatalogWorktree = `${community}.worktrees/feat/workflow-catalog`;
if (!process.env.COMMUNITY_PROFILES_DIR) {
  try { await access(join(workflowCatalogWorktree, "workflows")); community = workflowCatalogWorktree; } catch { /* use the explicitly configured or default checkout */ }
}
let outfitter = process.env.OUTFITTER_CLI || "outfitter";
const workflowOutfitter = join(repositoryRoot, "outfitter.worktrees/feat/workflow-resources/code/cli/dist/cli.js");
if (!process.env.OUTFITTER_CLI) {
  try { await access(workflowOutfitter); outfitter = workflowOutfitter; } catch { /* use the Outfitter available on PATH */ }
}
const scratch = await mkdtemp(join(tmpdir(), "website-workflows-"));
const sharedFiles = new Map();
function gitBlobSha(content) {
  const body = Buffer.from(content);
  return createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
}

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
      const relativePath = relative(root, path).replaceAll("\\", "/");
      const mode = "100644";
      if (relativePath !== ".outfitter/workflow-composition.json") {
        const previous = sharedFiles.get(relativePath);
        if (previous && (previous.content !== content || previous.mode !== mode)) throw new Error(`Workflow catalog collision at ${relativePath} between ${previous.workflow} and ${id}`);
        sharedFiles.set(relativePath, { workflow: id, content, mode });
      }
      bundledFiles.push({ path: relativePath, content, mode, sha256: createHash("sha256").update(content).digest("hex"), blobSha: gitBlobSha(content) });
    }
    catalog.push({ id, title: declaration.title, description: declaration.description, sourceSha, files: bundledFiles });
  }
  await mkdir(join(projectRoot, "src/generated"), { recursive: true });
  await writeFile(join(projectRoot, "src/generated/workflow-catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
