import { describe, expect, it, vi } from "vitest";
import { dispatchPendingProvisioning } from "./provisioning-dispatch";
import type { ProvisioningDispatchCandidate } from "./billing-store";

function candidate(operationId: string, billingAccountId: string): ProvisioningDispatchCandidate {
  return {
    operationId,
    billingAccountId,
    githubAccountId: `github-${billingAccountId}`,
    githubAccountLogin: billingAccountId,
    githubInstallationId: "123",
  };
}

describe("durable provisioning redispatch", () => {
  it("continues across tenant failures and dispatches once per queued operation", async () => {
    const candidates = [
      candidate("operation_1", "tenant-a"),
      candidate("operation_2", "tenant-b"),
      candidate("operation_3", "tenant-b"),
    ];
    const listProvisioningDispatchCandidates = vi.fn().mockResolvedValue(candidates);
    const dispatch = vi.fn(async (item: ProvisioningDispatchCandidate) => {
      if (item.billingAccountId === "tenant-a") throw new Error("GitHub unavailable");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(dispatchPendingProvisioning({} as Env, {
      store: { listProvisioningDispatchCandidates },
      dispatch,
      now: 1_000,
      limit: 3,
    })).resolves.toEqual({ scanned: 3, dispatched: 2, failed: 1 });

    expect(listProvisioningDispatchCandidates).toHaveBeenCalledWith(1_000, 3);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('"billingAccountId":"tenant-a"'));
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining("tenant-b"));
    error.mockRestore();
  });

  it("uses a bounded batch by default", async () => {
    const listProvisioningDispatchCandidates = vi.fn().mockResolvedValue([]);

    await expect(dispatchPendingProvisioning({} as Env, {
      store: { listProvisioningDispatchCandidates },
      dispatch: vi.fn(),
      now: 1_000,
    })).resolves.toEqual({ scanned: 0, dispatched: 0, failed: 0 });

    expect(listProvisioningDispatchCandidates).toHaveBeenCalledWith(1_000, 25);
  });
});
