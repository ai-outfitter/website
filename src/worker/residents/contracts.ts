import type { Workspace } from "../cli-state";
import { record } from "../inference/models";
export type ResidentRole = "project-manager" | "engineer";
export interface SelectedRepository { id: number; fullName: string }
export interface Enrollment {
  workspace: Workspace;
  installationId: number;
  repositories: SelectedRepository[];
  projectManagerName: string;
  engineerName: string;
}
export interface ResidentConfiguration extends Enrollment { enabled: boolean; credentialVersion: string; revision: string }
export interface ResidentStatus { state: "provisioning" | "ready" | "failed"; agents: { role: string; name: string; ready: boolean; reason?: string }[] }
export interface TriageTask {
  id: string;
  repository: SelectedRepository;
  issueNumber: number;
  availableLabels: string[];
  message: string;
}
export function validateEnrollment(value: Enrollment) {
  if (!/^(user|org):[1-9]\d*$/.test(value.workspace.id) || !["User", "Organization"].includes(value.workspace.type) || value.workspace.id.startsWith("org:") !== (value.workspace.type === "Organization") || !/^[\w.-]{1,100}$/.test(value.workspace.login) || !Number.isSafeInteger(value.installationId) || value.installationId <= 0) throw new Error("Invalid workspace");
  if (!value.repositories.length || value.repositories.length > 100 || new Set(value.repositories.map((repo) => repo.id)).size !== value.repositories.length || value.repositories.some((repo) => !Number.isSafeInteger(repo.id) || repo.id <= 0 || !/^[\w.-]+\/[\w.-]+$/.test(repo.fullName) || repo.fullName.split("/")[0].toLowerCase() !== value.workspace.login.toLowerCase())) throw new Error("Invalid repository selection");
  for (const name of [value.projectManagerName, value.engineerName]) if (typeof name !== "string" || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,62}$/u.test(name)) throw new Error("Use names of 1 to 63 letters, numbers, spaces, periods, underscores or hyphens");
}
export function sanitizedStatus(value: unknown): ResidentStatus {
  if (!record(value) || !["provisioning", "ready", "failed"].includes(String(value.state)) || !Array.isArray(value.agents) || value.agents.length !== 2) throw new Error("Invalid operator status");
  const agents = value.agents.map((agent) => {
    if (!record(agent) || !["project-manager", "engineer"].includes(String(agent.role)) || typeof agent.name !== "string" || typeof agent.ready !== "boolean") throw new Error("Invalid operator status");
    return { role: String(agent.role), name: agent.name.slice(0, 63), ready: agent.ready, ...(agent.reason ? { reason: "Resident is not ready; check operator status" } : {}) };
  });
  if (new Set(agents.map((agent) => agent.role)).size !== 2 || (value.state === "ready" && agents.some((agent) => !agent.ready))) throw new Error("Invalid operator readiness");
  return { state: value.state as ResidentStatus["state"], agents };
}
export const residentJson = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
export function residentFailure(message: string, status = 400): never { throw residentJson({ error: message }, status); }
