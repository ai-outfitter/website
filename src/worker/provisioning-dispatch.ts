import { installationOctokit } from "./app";
import { BillingStore, type ProvisioningDispatchCandidate } from "./billing-store";

const PROVISIONING_DISPATCH_BATCH_SIZE = 25;

type ProvisioningDispatchStore = Pick<BillingStore, "listProvisioningDispatchCandidates">;

export async function dispatchPendingProvisioning(
  env: Env,
  dependencies: {
    store?: ProvisioningDispatchStore;
    dispatch?: (candidate: ProvisioningDispatchCandidate) => Promise<void>;
    now?: number;
    limit?: number;
  } = {},
) {
  const store = dependencies.store ?? new BillingStore(env.BILLING_DB);
  const candidates = await store.listProvisioningDispatchCandidates(
    dependencies.now,
    dependencies.limit ?? PROVISIONING_DISPATCH_BATCH_SIZE,
  );
  let dispatched = 0;
  let failed = 0;

  for (const candidate of candidates) {
    try {
      if (dependencies.dispatch) {
        await dependencies.dispatch(candidate);
      } else {
        if (!/^\d+$/.test(candidate.githubInstallationId)) {
          throw new Error("GitHub installation ID is invalid");
        }
        const installationId = Number(candidate.githubInstallationId);
        if (!Number.isSafeInteger(installationId)) throw new Error("GitHub installation ID is invalid");
        const workflow = env.PROVISIONING_WORKFLOW?.trim();
        if (!workflow) throw new Error("Provisioning workflow is not configured");
        await installationOctokit(env, installationId).request(
          "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
          {
            owner: candidate.githubAccountLogin,
            repo: ".agents",
            workflow_id: workflow,
            ref: "main",
          },
        );
      }
      dispatched += 1;
    } catch (error) {
      failed += 1;
      console.error(JSON.stringify({
        message: "Resident provisioning redispatch failed",
        operationId: candidate.operationId,
        billingAccountId: candidate.billingAccountId,
        githubAccountId: candidate.githubAccountId,
        error: error instanceof Error ? error.message : "Unexpected error",
      }));
    }
  }
  return { scanned: candidates.length, dispatched, failed };
}
