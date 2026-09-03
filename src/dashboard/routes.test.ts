import { describe, expect, it } from "vitest";
import { dashboardPathForRoute, dashboardRoute, startPath } from "./routes";

describe("dashboard routes", () => {
  it("recognizes the onboarding start page for an account", () => {
    expect(dashboardRoute("/dashboard/acme/start/")).toEqual({ page: "start", account: "acme" });
    expect(dashboardRoute("/dashboard/acme/start")).toEqual({ page: "start", account: "acme" });
    expect(dashboardRoute("/dashboard/acme/")).toEqual({ page: "overview", account: "acme" });
    expect(dashboardRoute("/dashboard/acme/workflows/start/")).toEqual({ page: "workflow", account: "acme", workflow: "start" });
    expect(startPath("acme org")).toBe("/dashboard/acme%20org/start/");
    expect(dashboardPathForRoute("acme", { page: "start", account: "other" })).toBe("/dashboard/acme/start/");
  });
});
