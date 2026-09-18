import type { Octokit } from "@octokit/core";
import { parse } from "yaml";

const WORKFLOW_SOURCE_LIMIT = 256 * 1024;

export class ProvisionabilityError extends Error {
  constructor(readonly kind: "inactive" | "invalid") {
    super(kind === "inactive"
      ? "The configured provisioning workflow is not active"
      : "The configured provisioning workflow does not support workflow_dispatch");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function supportsWorkflowDispatch(source: string) {
  let document: unknown;
  try {
    document = parse(source, { maxAliasCount: 10 });
  } catch {
    return false;
  }
  if (!isRecord(document)) return false;
  const triggers = document.on;
  if (triggers === "workflow_dispatch") return true;
  if (Array.isArray(triggers)) return triggers.includes("workflow_dispatch");
  return isRecord(triggers) && Object.hasOwn(triggers, "workflow_dispatch");
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
  const metadata = await client.request("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}", {
    owner,
    repo: ".agents",
    workflow_id: workflow,
  });
  if (metadata.data.state !== "active") throw new ProvisionabilityError("inactive");

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
  if (!supportsWorkflowDispatch(source)) throw new ProvisionabilityError("invalid");
}
