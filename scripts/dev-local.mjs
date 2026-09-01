import { spawn, spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignored = [
  ".astro/", ".cache/", ".devenv/", ".direnv/", ".git/", ".wrangler/",
  "dist/", "node_modules/", "public/repository-assets/", "src/generated/",
  "src/pages/workflows/", "src/content/docs/docs/",
];

function rebuildsSite(filename) {
  if (!filename) return false;
  const path = String(filename).replaceAll("\\", "/");
  if (ignored.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix))) return false;
  return path === "astro.config.mjs"
    || path === "package.json"
    || path.startsWith("docs/")
    || path.startsWith("public/")
    || path.startsWith("src/");
}

const portResult = spawnSync("dev-port", ["4321", projectRoot], { encoding: "utf8" });
if (portResult.status !== 0) throw new Error(portResult.stderr || "Could not allocate a development port");
const port = portResult.stdout.trim();
const tailscaleResult = spawnSync("tailscale", ["ip", "-4"], { encoding: "utf8" });
const bindAddress = tailscaleResult.status === 0
  ? tailscaleResult.stdout.trim().split(/\s+/)[0]
  : "127.0.0.1";
let building = false;
let queued = false;
let debounce;
let buildChild;
let wrangler;
let intentionalStop = false;
let shuttingDown = false;

function startWrangler() {
  intentionalStop = false;
  wrangler = spawn("wrangler", [
    "dev", "--local", "--ip", bindAddress, "--port", port,
    "--define", "__LOCAL_PAT_DEV__:true",
    "--var", `LOCAL_DEV_PORT:${port}`,
  ], { cwd: projectRoot, stdio: "inherit" });
  wrangler.once("exit", (code, signal) => {
    wrangler = undefined;
    if (intentionalStop || shuttingDown) return;
    if (code === 0 && !signal) {
      shuttingDown = true;
      watcher.close();
      return;
    }
    watcher.close();
    console.error(`Wrangler exited unexpectedly (${signal ?? code ?? "unknown"}).`);
    process.exitCode = code || 1;
  });
}

function stopWrangler(signal = "SIGTERM") {
  return new Promise((resolveStop) => {
    if (!wrangler) return resolveStop();
    intentionalStop = true;
    wrangler.once("exit", resolveStop);
    wrangler.kill(signal);
  });
}

async function build() {
  if (shuttingDown) return;
  if (building) {
    queued = true;
    return;
  }
  building = true;
  await stopWrangler();
  if (shuttingDown) {
    building = false;
    return;
  }
  buildChild = spawn("npm", ["run", "build"], { cwd: projectRoot, stdio: "inherit" });
  buildChild.on("exit", (code) => {
    buildChild = undefined;
    building = false;
    if (code !== 0 && !shuttingDown) console.error(`Asset rebuild failed with exit code ${code}.`);
    if (!shuttingDown) startWrangler();
    if (queued) {
      queued = false;
      void build();
    }
  });
}

const watcher = watch(projectRoot, { recursive: true }, (_event, filename) => {
  if (!rebuildsSite(filename)) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => void build(), 150);
});

async function stop(signal) {
  shuttingDown = true;
  clearTimeout(debounce);
  watcher.close();
  if (buildChild) {
    const child = buildChild;
    await new Promise((resolveStop) => {
      child.once("exit", resolveStop);
      child.kill(signal);
    });
  }
  await stopWrangler(signal);
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
startWrangler();
