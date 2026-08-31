import { describe, expect, it, vi } from "vitest";
import { repositories } from "./github";

describe("managed repository discovery", () => {
  it("includes .agents repositories and ordinary repositories with a root .agents directory", async () => {
    const request = vi.fn(async (route: string, input: Record<string, unknown>) => {
      if (route === "GET /user/installations") return { data: { installations: [{ id: 7 }] } };
      if (route === "GET /user/installations/{installation_id}/repositories") return { data: { repositories: [
        { id: 1, name: ".agents", full_name: "octo/.agents", owner: { login: "octo" }, default_branch: "main", permissions: { push: true } },
        { id: 2, name: "project", full_name: "octo/project", owner: { login: "octo" }, default_branch: "trunk", permissions: { push: true } },
        { id: 3, name: "plain", full_name: "octo/plain", owner: { login: "octo" }, default_branch: "main", permissions: { push: true } },
      ] } };
      if (route === "GET /repos/{owner}/{repo}/contents/{path}" && input.repo === "project") return { data: [] };
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") throw Object.assign(new Error("not found"), { status: 404 });
      throw new Error(`Unexpected request: ${route}`);
    });
    const result = await repositories({ request } as never);
    expect(result.map(({ fullName, managedRoot }) => ({ fullName, managedRoot }))).toEqual([
      { fullName: "octo/.agents", managedRoot: "" },
      { fullName: "octo/project", managedRoot: ".agents" },
    ]);
    expect(request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/contents/{path}", expect.objectContaining({ repo: "project", path: ".agents", ref: "trunk" }));
  });
});
