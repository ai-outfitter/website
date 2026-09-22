import { boundedText } from "../inference/stream";
import { sanitizedStatus, type ResidentConfiguration, type TriageTask } from "./contracts";
import { residentToken } from "./credentials";

function operatorUrl(env: Env, workspace: string, suffix = "") {
  if (!env.RESIDENT_OPERATOR_URL || !env.RESIDENT_OPERATOR_TOKEN) throw new Error("Resident operator unavailable");
  const url = new URL(env.RESIDENT_OPERATOR_URL);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("Invalid operator URL");
  return `${url.origin}/v1/residents/${encodeURIComponent(workspace)}${suffix}`;
}
async function callOperator(env: Env, workspace: string, method: string, value?: unknown, suffix = "") {
  return fetch(operatorUrl(env, workspace, suffix), { method, headers: { authorization: `Bearer ${env.RESIDENT_OPERATOR_TOKEN}`, "content-type": "application/json" }, body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(20_000), redirect: "error" });
}
export async function provisionResidents(env: Env, config: ResidentConfiguration) {
  const origin = new URL(env.BETTER_AUTH_URL);
  if (origin.protocol !== "https:" || !env.RESIDENT_CREDENTIAL_SECRET) throw new Error("Resident service unavailable");
  const [projectManagerToken, engineerToken, taskToken] = await Promise.all(["project-manager", "engineer", "task"].map((role) => residentToken(env.RESIDENT_CREDENTIAL_SECRET!, config.workspace.id, role as "project-manager" | "engineer" | "task", config.credentialVersion)));
  const response = await callOperator(env, config.workspace.id, "PUT", { workspace: config.workspace, installationId: config.installationId, repositories: config.repositories, projectManagerName: config.projectManagerName, engineerName: config.engineerName, serviceBaseUrl: origin.origin, projectManagerToken, engineerToken, taskToken });
  if (!response.ok) { await response.body?.cancel(); throw new Error("Resident provisioning failed"); }
  return sanitizedStatus(JSON.parse(await boundedText(response, 65_536)));
}
export async function residentStatus(env: Env, workspace: string) {
  const response = await callOperator(env, workspace, "GET");
  if (!response.ok) { await response.body?.cancel(); throw new Error("Resident status unavailable"); }
  return sanitizedStatus(JSON.parse(await boundedText(response, 65_536)));
}
export async function sendTriage(env: Env, workspace: string, task: TriageTask) {
  const response = await callOperator(env, workspace, "POST", task, "/tasks");
  const accepted = response.status === 202;
  await response.body?.cancel();
  if (!accepted) throw new Error("Resident task not accepted");
}
