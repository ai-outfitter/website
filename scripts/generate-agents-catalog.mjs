import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedCatalog = join(projectRoot, "src/generated/workflow-catalog.json");
const sourceRepository = "ai-outfitter/community-profiles";
const sha256 = (content) => createHash("sha256").update(content).digest("hex");
function gitBlobSha(content) {
  const body = Buffer.from(content);
  return createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
}

async function validateEmbeddedCatalog() {
  const catalog = JSON.parse(await readFile(generatedCatalog, "utf8"));
  if (!Array.isArray(catalog) || !catalog.length) throw new Error("Embedded workflow catalog is empty");
  const sourceSha = catalog[0].sourceSha;
  const sourceRef = catalog[0].sourceRef;
  if (!sourceRef || !/^[0-9a-f]{40}$/.test(sourceSha) || catalog.some((workflow) => workflow.sourceSha !== sourceSha || workflow.sourceRef !== sourceRef)) throw new Error("Embedded workflows must share one source release");
  for (const workflow of catalog) {
    if (!workflow.id || !Array.isArray(workflow.files) || !workflow.files.length) throw new Error(`Embedded workflow is incomplete: ${workflow.id ?? "unknown"}`);
    const paths = new Set();
    for (const file of workflow.files) {
      if (!file.path || paths.has(file.path)) throw new Error(`Duplicate embedded path in ${workflow.id}: ${file.path}`);
      paths.add(file.path);
      if (file.sha256 !== sha256(file.content) || file.blobSha !== gitBlobSha(file.content)) throw new Error(`Embedded catalog hash mismatch: ${workflow.id}/${file.path}`);
    }
  }
  console.log(`Validated ${catalog.length} embedded workflow bundles at ${sourceSha}.`);
}

if (process.env.AGENTS_CATALOG_EMBEDDED_ONLY === "1") {
  await validateEmbeddedCatalog();
  process.exit(0);
}

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
const sharedFiles = new Map();

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
  const sourceRef = execFileSync("git", ["tag", "--contains", sourceSha, "--sort=-version:refname"], { cwd: community, encoding: "utf8" }).trim().split("\n")[0];
  if (!sourceRef) throw new Error(`Community catalog ${sourceSha} is not contained in a release tag`);
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
      bundledFiles.push({ path: relativePath, content, mode, sha256: sha256(content), blobSha: gitBlobSha(content) });
    }
    catalog.push({ id, title: declaration.title, description: declaration.description, sourceRepository, sourceRef, sourceSha, files: bundledFiles });
  }
  await mkdir(join(projectRoot, "src/generated"), { recursive: true });
  await writeFile(generatedCatalog, `${JSON.stringify(catalog, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
