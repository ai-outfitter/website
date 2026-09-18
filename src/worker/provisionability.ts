import type { Octokit } from "@octokit/core";
import { parse } from "yaml";

const WORKFLOW_SOURCE_LIMIT = 256 * 1024;

export class ProvisionabilityError extends Error {
  constructor(readonly kind: "inactive" | "invalid") {
    super(kind === "inactive"
      ? "The configured provisioning workflow is not active"
      : "The configured provisioning workflow does not satisfy the resident provisioning contract");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactPermissions(value: unknown) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 2
    && keys[0] === "contents"
    && keys[1] === "id-token"
    && value.contents === "read"
    && value["id-token"] === "write";
}

function satisfiesProvisioningContract(source: string, owner: string) {
  let document: unknown;
  try {
    document = parse(source, { maxAliasCount: 10 });
  } catch {
    return false;
  }
  if (!isRecord(document)) return false;
  const triggers = document.on;
  if (!(isRecord(triggers)
    && Object.keys(triggers).length === 1
    && Object.hasOwn(triggers, "workflow_dispatch"))) return false;

  // The dispatch entrypoint does not run arbitrary steps. It delegates one job
  // to the reviewed deployment workflow on the protected default branch. That
  // reusable workflow is therefore the value GitHub places in job_workflow_ref.
  const jobs = document.jobs;
  if (!isRecord(jobs) || Object.keys(jobs).length !== 1) return false;
  const job = Object.values(jobs)[0];
  if (!isRecord(job)
    || job.uses !== `${owner}/.agents/.github/workflows/deploy.yml@main`
    || Object.hasOwn(job, "runs-on")
    || Object.hasOwn(job, "steps")) return false;

  // A called workflow can only retain or reduce its caller's permissions. Give
  // it precisely the repository read and OIDC capabilities used by deployment,
  // and reject broader caller permissions such as write-all.
  return exactPermissions(job.permissions ?? document.permissions);
}

export function pilotAccountAllowed(githubAccountId: number, configuredIds: string | undefined) {
  if (!Number.isSafeInteger(githubAccountId) || githubAccountId <= 0) return false;
  const ids = configuredIds?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  return ids.length > 0 && ids.every((value) => /^\d+$/.test(value))
    && ids.includes(String(githubAccountId));
}

/** Prove the scoped installation token can see an active workflow on the
 * exact ref the webhook will dispatch, and that the workflow declares the
 * dispatch event. */
export async function verifyProvisioningWorkflow(
  client: Pick<Octokit, "request">,
  owner: string,
  workflow: string,
  ref = "main",
) {
  const expectedPath = `.github/workflows/${workflow}`;
  const metadata = await client.request("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}", {
    owner,
    repo: ".agents",
    workflow_id: workflow,
  });
  if (metadata.data.state !== "active") throw new ProvisionabilityError("inactive");
  if (metadata.data.path !== expectedPath) throw new ProvisionabilityError("invalid");

  const content = await client.request("GET /repos/{owner}/{repo}/contents/{path}", {
    owner,
    repo: ".agents",
    path: metadata.data.path,
    ref,
  });
  if (Array.isArray(content.data) || content.data.type !== "file"
    || content.data.encoding !== "base64" || typeof content.data.content !== "string"
    || content.data.size > WORKFLOW_SOURCE_LIMIT) {
    throw new ProvisionabilityError("invalid");
  }
  const source = new TextDecoder().decode(Uint8Array.from(
    atob(content.data.content.replaceAll("\n", "")),
    (character) => character.charCodeAt(0),
  ));
  if (!satisfiesProvisioningContract(source, owner)) throw new ProvisionabilityError("invalid");
}
